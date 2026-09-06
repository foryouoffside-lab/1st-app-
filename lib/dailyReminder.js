// lib/dailyReminder.js
// A local, on-device notification that nudges a lapsed player back to their
// Daily Challenge. Deliberately NOT push notifications — those need Firebase
// Cloud Messaging plus a server-side trigger to send them. This is the
// simpler, no-server version: Capacitor's LocalNotifications schedules the
// reminder directly on the device, repeating daily at a fixed local time.

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const DAILY_REMINDER_ID = 1001;
// 6pm local device time — a reasonable default, not a tuned send-time.
const REMINDER_HOUR = 18;
const REMINDER_MINUTE = 0;

// Requests permission (if needed) and schedules the recurring reminder.
// Safe to call on every app launch — it checks for the existing pending
// notification first so it never double-schedules.
export async function ensureDailyReminderScheduled() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    let status = await LocalNotifications.checkPermissions();
    if (status.display !== 'granted') {
      status = await LocalNotifications.requestPermissions();
    }
    if (status.display !== 'granted') return;

    const pending = await LocalNotifications.getPending();
    if (pending.notifications.some((n) => n.id === DAILY_REMINDER_ID)) return;

    await LocalNotifications.schedule({
      notifications: [{
        id: DAILY_REMINDER_ID,
        title: "Today's drills are waiting",
        body: 'Three drills, double XP. Keep your streak alive — the set resets at midnight.',
        schedule: { on: { hour: REMINDER_HOUR, minute: REMINDER_MINUTE }, allowWhileIdle: true },
        extra: { route: '/daily' },
      }],
    });
  } catch (err) {
    console.error('Failed to schedule daily reminder:', err);
  }
}
