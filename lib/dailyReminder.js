// lib/dailyReminder.js
// A local, on-device notification that nudges a lapsed player back to their
// daily session. NOT push — that needs Firebase Cloud Messaging plus a server
// trigger. Capacitor's LocalNotifications schedules it directly on the device.
//
// What changed from the old "fire at 18:00 every day forever" version:
//   • The time is a player setting (sd_reminder), not a constant.
//   • It is a SINGLE scheduled notification at the next relevant time, not a
//     daily-repeat — because a repeat can't know today's session is already
//     done. Every app launch / resume / session-completion recomputes it:
//       – session still open and it's before today's reminder time  → today
//       – otherwise                                                 → tomorrow
//     which is how "suppress when today is complete" and "handle the date
//     changing while backgrounded" both fall out of one code path.
//   • Permission is requested AT MOST ONCE, ever (permissionAsked). If the
//     player said no, we never prompt again — they can re-enable from the
//     Progress screen, which re-arms the ask.
//   • The tap deep-links to /daily, which already renders the right state
//     (Start / Continue — N left / Complete).

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Storage } from './storage';
import { getDailyChallenge } from './dailyChallenge';

export const DAILY_REMINDER_ID = 1001;
const REMINDER_KEY = 'sd_reminder';

const DEFAULTS = { enabled: true, hour: 18, minute: 0, permissionAsked: false };

export async function getReminderSettings() {
  const stored = await Storage.getJSON(REMINDER_KEY, null);
  if (!stored || typeof stored !== 'object') return { ...DEFAULTS };
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
    hour: Number.isInteger(stored.hour) ? Math.min(23, Math.max(0, stored.hour)) : DEFAULTS.hour,
    minute: Number.isInteger(stored.minute) ? Math.min(59, Math.max(0, stored.minute)) : DEFAULTS.minute,
    permissionAsked: !!stored.permissionAsked,
  };
}

async function saveReminderSettings(next) {
  await Storage.setJSON(REMINDER_KEY, next);
}

/**
 * Update the player's reminder preference (from the Progress screen) and
 * re-arm the schedule. Turning it back on also RE-ARMS the permission prompt,
 * since a deliberate opt-in is a fair moment to ask again.
 */
export async function setReminderPref({ enabled, hour, minute }) {
  const cur = await getReminderSettings();
  const next = { ...cur };
  if (typeof enabled === 'boolean') {
    next.enabled = enabled;
    if (enabled && !cur.enabled) next.permissionAsked = false;
  }
  if (Number.isInteger(hour)) next.hour = Math.min(23, Math.max(0, hour));
  if (Number.isInteger(minute)) next.minute = Math.min(59, Math.max(0, minute));
  await saveReminderSettings(next);
  await ensureDailyReminderScheduled();
  return next;
}

function nextFireDate(settings, sessionComplete) {
  const now = new Date();
  const todayAt = new Date(now);
  todayAt.setHours(settings.hour, settings.minute, 0, 0);

  // Today, only if the session is still open and that time hasn't passed.
  if (!sessionComplete && todayAt.getTime() > now.getTime() + 60_000) return todayAt;

  const tomorrow = new Date(todayAt);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

/**
 * Cancel any pending reminder and, if it's still wanted, schedule the next
 * single occurrence. Safe to call on every launch / resume / completion.
 */
export async function ensureDailyReminderScheduled() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    // Always start from a clean slate — this replaces the old getPending()
    // de-dupe, which couldn't cope with a one-shot schedule that needs to move.
    await LocalNotifications.cancel({ notifications: [{ id: DAILY_REMINDER_ID }] });

    const settings = await getReminderSettings();
    if (!settings.enabled) return;

    let status = await LocalNotifications.checkPermissions();
    if (status.display !== 'granted') {
      if (settings.permissionAsked) return; // asked once already — never nag
      await saveReminderSettings({ ...settings, permissionAsked: true });
      status = await LocalNotifications.requestPermissions();
      if (status.display !== 'granted') return;
    }

    let sessionComplete = false;
    try {
      const daily = await getDailyChallenge();
      sessionComplete = !!daily.allComplete && daily.total > 0;
    } catch { /* treat as not complete */ }

    const at = nextFireDate(settings, sessionComplete);

    await LocalNotifications.schedule({
      notifications: [{
        id: DAILY_REMINDER_ID,
        title: sessionComplete ? 'Your next session is ready' : "Today's session is waiting",
        body: sessionComplete
          ? 'A fresh set of three drills, double XP. Keep the week going.'
          : 'Three drills, double XP. It only takes a few minutes.',
        schedule: { at, allowWhileIdle: true },
        extra: { route: '/daily' },
      }],
    });
  } catch (err) {
    console.error('Failed to schedule daily reminder:', err);
  }
}
