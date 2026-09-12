'use client';

// app/progress/ProgressClient.js
// SkillDrills Pro — Personal Progress Screen
// Shows: Level/XP, streak, top scores, settings, data management

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import AvatarEditor from 'react-avatar-editor';
import {
  Volume2, VolumeOff, ChevronRight, LogOut, ShieldAlert, Camera,
  FileText, TrendingUp, TrendingDown, Minus, Lock, Bell, BellOff
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePlayerProgress } from '../../contexts/PlayerProgressContext';
import { doc, updateDoc } from 'firebase/firestore';
import {
  getStreak, getTotalSessions, getDrillsPlayed,
  clearAllProgress, getSettings, updateSettings
} from '../../lib/progressStore';
import { Storage } from '../../lib/storage';
import { DRILL_INDEX } from '../../lib/drillIndex';
import { DRILL_GROUPS, getDrillGroup } from '../../lib/drillGroups';
import { getDrillTrends, getHeadlineTrend } from '../../lib/progressInsights';
import { resolveAchievements } from '../../lib/achievements';
import { getWeeklyGoal } from '../../lib/weeklyGoal';
import { getReminderSettings, setReminderPref } from '../../lib/dailyReminder';
import LevelBadge from '../../components/LevelBadge';

const RADAR_CATEGORIES = DRILL_GROUPS.map(g => ({ slug: g.id, name: g.name }));

export default function ProgressClient() {
  const { user, db, signOut, deleteAccount } = useAuth();
  const [photoFile, setPhotoFile] = useState(null);
  const [photoScale, setPhotoScale] = useState(1.2);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const avatarEditorRef = useRef(null);
  const fileInputRef = useRef(null);
  const { progress: playerProgress, status: progressStatus } = usePlayerProgress();
  const level = playerProgress?.level ?? null;
  const xpIn = playerProgress?.xpInLevel ?? 0;
  const xpTo = playerProgress?.xpToNext ?? 1000;
  const totalXP = playerProgress?.xp ?? 0;
  const [streak,   setStreak]   = useState({ current: 0, longest: 0 });
  const [sessions, setSessions] = useState(0);
  const [drillsP,  setDrillsP]  = useState(0);
  const [sound,    setSound]    = useState(true);
  const [cleared,  setCleared]  = useState(false);

  const [guestName, setGuestName] = useState('Guest Player');
  const [editingName, setEditingName] = useState(false);
  const [tempName, setTempName] = useState('');

  const [radarAxes, setRadarAxes] = useState([]);
  const [heatmapCells, setHeatmapCells] = useState([]);
  const [trends, setTrends] = useState([]);
  const [headline, setHeadline] = useState(null);
  const [achievements, setAchievements] = useState(null);
  const [reminder, setReminder] = useState(null);

  const displayName = user?.displayName || guestName;

  useEffect(() => {
    async function load() {
      const [s, sess, dp, settings, history, scores, drillTrends, headlineTrend, weekly, rem] = await Promise.all([
        getStreak(), getTotalSessions(),
        getDrillsPlayed(), getSettings(),
        Storage.getJSON('sd_history', {}), Storage.getJSON('sd_scores', {}),
        getDrillTrends().catch(() => []),
        getHeadlineTrend().catch(() => null),
        getWeeklyGoal().catch(() => null),
        getReminderSettings().catch(() => null),
      ]);

      setStreak(s);
      setSessions(sess);
      setDrillsP(dp);
      setSound(settings.soundEnabled ?? true);
      setTrends(drillTrends);
      setHeadline(headlineTrend);
      setReminder(rem);
      setAchievements(resolveAchievements({
        sessions: sess,
        drillsPlayed: dp,
        longestStreak: s.longest || 0,
        weeksCompleted: weekly?.weeksCompleted || 0,
      }));

      // Load guest name
      if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('sd_guest_name');
        if (saved) setGuestName(saved);
      }

      // Radar axes: unique drills touched + total sessions per category.
      const categoryData = {};
      RADAR_CATEGORIES.forEach(c => {
        categoryData[c.slug] = { uniquePlayed: 0, totalSessions: 0 };
      });
      Object.entries(scores || {}).forEach(([drillId, data]) => {
        const drill = DRILL_INDEX.find(d => d.id === drillId);
        const slug = drill ? getDrillGroup(drill) : 'attention';
        if (categoryData[slug]) {
          categoryData[slug].uniquePlayed += 1;
          categoryData[slug].totalSessions += (data.attempts || 0);
        }
      });
      const activeAxes = RADAR_CATEGORIES.map(c => {
        const stats = categoryData[c.slug];
        const value = Math.min(100, (stats.uniquePlayed * 25) + (stats.totalSessions * 2.5));
        return { ...c, value, totalSessions: stats.totalSessions };
      }).filter(axis => axis.totalSessions > 0);

      let finalAxes = [...activeAxes];
      if (finalAxes.length < 3) {
        const defaults = ['attention', 'focus', 'memory'];
        defaults.forEach(slug => {
          if (!finalAxes.some(a => a.slug === slug)) {
            const cat = RADAR_CATEGORIES.find(c => c.slug === slug);
            if (cat) finalAxes.push({ ...cat, value: 0, totalSessions: 0 });
          }
        });
      }
      setRadarAxes(finalAxes);

      // Calculate consistency heatmap cells (last 70 days)
      const countsByDate = {};
      Object.values(history || {}).forEach(list => {
        list.forEach(item => {
          if (item.date) {
            const dStr = item.date.split('T')[0];
            countsByDate[dStr] = (countsByDate[dStr] || 0) + 1;
          }
        });
      });

      const tempCells = [];
      for (let i = 69; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const dStr = d.toISOString().split('T')[0];
        const count = countsByDate[dStr] || 0;
        let levelClass = '';
        if (count > 0 && count <= 2) levelClass = 'l1';
        else if (count > 2 && count <= 5) levelClass = 'l2';
        else if (count > 5) levelClass = 'l3';

        const formattedDate = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        tempCells.push({
          dateStr: dStr,
          count,
          levelClass,
          title: `${formattedDate}: ${count} session${count === 1 ? '' : 's'}`
        });
      }
      setHeatmapCells(tempCells);
    }
    load();

    // Re-read when a cloud restore lands (lib/progressCloud.js) — on the first
    // open after a reinstall this screen can otherwise sit on the empty
    // pre-restore numbers, which is precisely the screen the player opens to
    // check their level and rank badge survived.
    const onRestored = () => { load(); };
    window.addEventListener('sd:progress-restored', onRestored);
    return () => window.removeEventListener('sd:progress-restored', onRestored);
  }, [cleared]);

  async function toggleSound() {
    const next = !sound;
    setSound(next);
    await updateSettings({ soundEnabled: next });
  }

  async function toggleReminder() {
    if (!reminder) return;
    const next = await setReminderPref({ enabled: !reminder.enabled });
    setReminder(next);
  }

  async function changeReminderTime(value) {
    // <input type="time"> gives "HH:MM"
    const [h, m] = String(value || '').split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return;
    const next = await setReminderPref({ hour: h, minute: m });
    setReminder(next);
  }

  const reminderTimeValue = reminder
    ? `${String(reminder.hour).padStart(2, '0')}:${String(reminder.minute).padStart(2, '0')}`
    : '18:00';

  const handleEditName = () => {
    setTempName(displayName);
    setEditingName(true);
  };

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    try {
      // Signed-in accounts can no longer rename here — display names are
      // permanent once chosen at signup (see completeSignup in
      // contexts/AuthContext.js and the users/{uid} rule in firestore.rules,
      // which reject a displayName change outright). This path only ever
      // runs for guests now, whose local-only nickname isn't a unique,
      // invite-by-name account identity, so it's free to change.
      if (user && db) return;
      localStorage.setItem('sd_guest_name', tempName.trim());
      setEditingName(false);
      setCleared(c => !c);
    } catch (e) {
      console.error("Failed to save profile name:", e);
    }
  };

  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  const handlePhotoFileSelected = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPhotoError('Please choose an image file.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError('Image must be under 5MB.');
      return;
    }
    setPhotoError('');
    setPhotoScale(1.2);
    setPhotoFile(file);
  };

  const handleCancelPhotoEdit = () => {
    setPhotoFile(null);
    setPhotoError('');
  };

  // Firebase Storage needs the (paid, card-on-file) Blaze plan, which this
  // project isn't on — so the photo is stored inline as a compressed base64
  // data URL directly on the Firestore user doc instead. Firestore's
  // document limit is 1MB; a 128x128 JPEG is nowhere close, and
  // firestore.rules independently caps this field at 300KB as a backstop.
  const DATA_URL_SAFETY_LIMIT = 280000; // stay under the 300KB rule cap

  // ...but that 300KB rule cap is only a backstop against absurd values, and
  // it is FAR too loose to be what actually governs the stored size, because
  // this field is not read one profile at a time. It rides along with every
  // bulk profile read in the app: the Arena's online-players list (40 docs),
  // the leaderboard (50 docs), and a copy is stamped into each challenge doc
  // as fromPhoto/toPhoto (see sendChallenge in lib/challengeEngine.js), which
  // the open-lobby list then reads 30 at a time. So one Arena visit can pull
  // a hundred-plus copies of somebody's avatar, and the per-photo size is
  // multiplied by all of them.
  //
  // A single quality setting can't bound that, since how many bytes a given
  // quality produces depends entirely on how busy the photo is — a flat
  // portrait and a detailed outdoor shot at the same setting differ several
  // times over. So encode repeatedly, stepping quality down until the result
  // actually fits a byte budget. Almost every photo lands on the first step;
  // busy ones take one or two more and end up slightly softer instead of
  // several times larger. Pixel dimensions are deliberately NOT reduced —
  // 128px is already only just enough for the 58px profile avatar on a 3x
  // display, so quality is the axis with headroom, not size.
  const AVATAR_BYTE_BUDGET = 14000;
  const AVATAR_QUALITY_STEPS = [0.72, 0.6, 0.48, 0.36, 0.26];

  const handleSavePhoto = async () => {
    if (!avatarEditorRef.current || !user || !db) return;
    setUploadingPhoto(true);
    setPhotoError('');
    try {
      const canvas = avatarEditorRef.current.getImageScaledToCanvas();
      let dataUrl = '';
      for (const quality of AVATAR_QUALITY_STEPS) {
        dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= AVATAR_BYTE_BUDGET) break;
      }
      // Falling off the end of the loop keeps the smallest attempt rather than
      // failing — at 128px even the lowest step is a couple of KB, so the hard
      // limit below is now effectively unreachable and the "too complex to
      // compress" message should no longer be something a real photo can hit.
      if (dataUrl.length > DATA_URL_SAFETY_LIMIT) {
        throw new Error('too-large');
      }

      await updateDoc(doc(db, 'users', user.uid), { photoURL: dataUrl });
      // Don't mutate `user` in place — it's the exact object AuthContext holds
      // in its own state, and assigning a property on it directly changes the
      // data without ever calling setUser, so nothing that reads `user` from
      // context (this page, the header, Arena) re-renders to show the new
      // photo. AuthContext's own onSnapshot live-sync on this doc (see
      // contexts/AuthContext.js) picks up this write and updates the real
      // state properly; this local copy only needs to exist to refresh the
      // cached session so a cold app restart doesn't repaint the old photo
      // for a moment before that listener reattaches.
      localStorage.setItem('sd_user_session', JSON.stringify({ ...user, photoURL: dataUrl }));

      setPhotoFile(null);
      setCleared(c => !c);
    } catch (e) {
      console.error('Failed to save profile photo:', e);
      setPhotoError(e?.message === 'too-large'
        ? 'That photo is too complex to compress small enough — try a simpler image.'
        : 'Save failed — try again.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (confirm("Are you absolutely sure you want to permanently delete your account? This deletes your profile, duel history, and sign-in — and cannot be undone.")) {
      try {
        if (user) {
          const result = await deleteAccount();
          if (!result.ok) {
            alert("Failed to delete account: " + result.error);
            return;
          }
        } else {
          await clearAllProgress();
        }
        localStorage.removeItem('sd_guest_name');
        setGuestName('Guest Player');
        setCleared(c => !c);
        alert("Your account and all associated data have been permanently deleted.");
      } catch (err) {
        console.error("Failed to delete account data:", err);
        alert("Failed to delete account: " + err.message);
      }
    }
  };

  const xpProgress = Math.round((xpIn / (xpIn + xpTo)) * 100);

  const renderRadarChart = (axes) => {
    const N = axes.length;
    const cx = 100;
    const cy = 105;
    const r = 65;

    const gridLevels = [0.25, 0.5, 0.75, 1.0];
    const gridPolygons = gridLevels.map(level => {
      const points = [];
      for (let i = 0; i < N; i++) {
        const angle = (i * 2 * Math.PI) / N - Math.PI / 2;
        const x = cx + r * level * Math.cos(angle);
        const y = cy + r * level * Math.sin(angle);
        points.push(`${x},${y}`);
      }
      return points.join(' ');
    });

    const axisLines = [];
    const labels = [];
    for (let i = 0; i < N; i++) {
      const angle = (i * 2 * Math.PI) / N - Math.PI / 2;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      
      axisLines.push({ x1: cx, y1: cy, x2: x, y2: y });

      const labelDistance = r + 16;
      const lx = cx + labelDistance * Math.cos(angle);
      const ly = cy + labelDistance * Math.sin(angle);
      
      labels.push({
        text: axes[i].name,
        x: lx,
        y: ly,
        textAnchor: Math.abs(Math.cos(angle)) < 0.1 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end',
      });
    }

    const userPointsArray = [];
    for (let i = 0; i < N; i++) {
      const angle = (i * 2 * Math.PI) / N - Math.PI / 2;
      const pct = axes[i].value / 100;
      const x = cx + r * pct * Math.cos(angle);
      const y = cy + r * pct * Math.sin(angle);
      userPointsArray.push(`${x},${y}`);
    }
    const userPolygonPoints = userPointsArray.join(' ');

    return (
      <svg width="250" height="240" viewBox="0 0 200 210" className="mx-auto overflow-visible">
        {gridPolygons.map((points, idx) => (
          <polygon
            key={idx}
            points={points}
            fill="none"
            stroke="rgba(255, 255, 255, 0.05)"
            strokeWidth="1"
          />
        ))}

        {axisLines.map((line, idx) => (
          <line
            key={idx}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="rgba(255, 255, 255, 0.05)"
            strokeWidth="1"
          />
        ))}

        {labels.map((label, idx) => (
          <text
            key={idx}
            x={label.x}
            y={label.y}
            textAnchor={label.textAnchor}
            alignmentBaseline="middle"
            className="text-[9px] font-black tracking-tight"
            fill="var(--text-faint)"
          >
            {label.text}
          </text>
        ))}

        {userPolygonPoints && (
          <polygon
            points={userPolygonPoints}
            fill="rgba(139, 92, 246, 0.25)"
            stroke="var(--brand-2)"
            strokeWidth="2"
          />
        )}

        {axes.map((axis, i) => {
          const angle = (i * 2 * Math.PI) / N - Math.PI / 2;
          const pct = axis.value / 100;
          const x = cx + r * pct * Math.cos(angle);
          const y = cy + r * pct * Math.sin(angle);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r="3.5"
              fill="var(--brand-3)"
              stroke="var(--ink)"
              strokeWidth="1"
            />
          );
        })}
      </svg>
    );
  };

  return (
    <div className="min-h-screen pb-28 text-slate-100" style={{ background: '#050508', paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
      <div className="px-4 pt-0 max-w-lg mx-auto space-y-6">

        {/* ── Page Title ── */}
        <h1 className="font-display text-[28px] text-white">Your Progress</h1>

        {/* ── Profile Hero ── */}
        <div className="p-hero">
          <div className="relative flex-shrink-0">
            {user?.photoURL ? (
              <img
                src={user.photoURL}
                alt={displayName}
                referrerPolicy="no-referrer"
                className="p-avatar object-cover"
              />
            ) : (
              <div className="p-avatar bg-gradient-to-br from-fuchsia-400 to-violet-500">
                {displayName.substring(0, 2).toUpperCase()}
              </div>
            )}
            {user && (
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Change profile photo"
                className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-violet-600 hover:bg-violet-500 border-2 border-[#0e0f16] flex items-center justify-center cursor-pointer transition-colors"
              >
                <Camera className="w-3 h-3 text-white" />
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoFileSelected}
              className="hidden"
            />
          </div>
          <div className="who">
            {editingName ? (
              <div className="flex items-center gap-2 mt-1">
                <input 
                  type="text" 
                  value={tempName} 
                  onChange={(e) => setTempName(e.target.value)}
                  className="bg-[#12131c] border border-[#232433] rounded-xl px-2.5 py-1 text-sm font-bold text-white max-w-[140px] focus:outline-none focus:border-violet-500"
                  autoFocus
                />
                <button onClick={handleSaveName} className="text-xs bg-emerald-400 text-black px-2.5 py-1.5 rounded-xl font-black transition hover:bg-emerald-300">Save</button>
                <button onClick={() => setEditingName(false)} className="text-xs bg-neutral-700 text-white px-2.5 py-1.5 rounded-xl font-bold">Cancel</button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <b>{displayName}</b>
                  {playerProgress && <LevelBadge level={level} />}
                </div>
                <span>{playerProgress ? `Level ${level} / ${drillsP} drills played` : (progressStatus === 'unavailable' ? 'Waiting to restore progress?' : 'Restoring progress?')}</span>
              </>
            )}
          </div>
          {/* Guests only — a signed-in account's display name is permanent
              (see handleSaveName above), so there's nothing left to edit
              here once a real account exists. */}
          {!editingName && !user && (
            <button className="p-edit cursor-pointer" onClick={handleEditName}>Edit Profile</button>
          )}
        </div>

        {/* ── Level Progress ── */}
        {playerProgress && <div className="p-xp">
          <div className="p-xp-top">
            <span>XP PROGRESS</span>
            <b>{xpIn.toLocaleString()} / {(xpIn + xpTo).toLocaleString()} XP</b>
          </div>
          <div className="rs-track">
            <div className="rs-fill" style={{ width: `${xpProgress}%` }} />
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 text-center">
            Total lifetime: <span className="text-violet-400 font-bold">{totalXP.toLocaleString()} XP</span>
          </div>
        </div>}

        {/* ── Activity (how much you've trained — NOT how well) ── */}
        <div>
          <div className="section-label">Activity</div>
          <div className="grid grid-cols-3 gap-2.5">
            <div className="rounded-2xl border border-[#232433] bg-[#12131c] p-3 text-center">
              <b className="block font-hud text-lg font-semibold tabular-nums text-white">{sessions}</b>
              <span className="mt-0.5 block text-[9px] font-black uppercase tracking-[0.08em] text-[var(--text-faint)]">Sessions</span>
            </div>
            <div className="rounded-2xl border border-[#232433] bg-[#12131c] p-3 text-center">
              <b className="block font-hud text-lg font-semibold tabular-nums text-white">{streak.current}d</b>
              <span className="mt-0.5 block text-[9px] font-black uppercase tracking-[0.08em] text-[var(--text-faint)]">Day streak</span>
            </div>
            <div className="rounded-2xl border border-[#232433] bg-[#12131c] p-3 text-center">
              <b className="block font-hud text-lg font-semibold tabular-nums text-white">{drillsP}/10</b>
              <span className="mt-0.5 block text-[9px] font-black uppercase tracking-[0.08em] text-[var(--text-faint)]">Drills tried</span>
            </div>
          </div>
        </div>

        {/* ── Your scores (performance — kept separate from Activity) ── */}
        <div>
          <div className="section-label">Your scores</div>
          <div className="rounded-2xl border border-[#232433] bg-[#12131c] p-4">
            {headline && (
              <p className={`text-[12.5px] leading-snug ${headline.enough ? 'text-slate-200' : 'text-slate-400'}`}>
                {headline.text}
              </p>
            )}

            {trends.some(t => t.enough) ? (
              <div className="mt-3 space-y-1.5">
                {trends.filter(t => t.enough).slice(0, 6).map(t => {
                  const Icon = t.direction === 'up' ? TrendingUp : t.direction === 'down' ? TrendingDown : Minus;
                  const col = t.direction === 'up' ? 'text-emerald-400' : t.direction === 'down' ? 'text-orange-400' : 'text-slate-400';
                  return (
                    <div key={t.drillId} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{t.name}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                        {t.earlier.toLocaleString()} → <span className="text-slate-200">{t.recent.toLocaleString()}</span>
                      </span>
                      <span className={`flex shrink-0 items-center gap-0.5 text-[11px] font-bold tabular-nums ${col}`}>
                        <Icon className="h-3 w-3" />
                        {t.deltaPct > 0 ? '+' : ''}{t.deltaPct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">
                Each drill needs about {8} scored runs before a recent-vs-earlier comparison is meaningful.
              </p>
            )}

            <p className="mt-3 border-t border-white/5 pt-2.5 text-[10px] leading-relaxed text-slate-500">
              &ldquo;Recent&rdquo; is the median of your last 5 runs, compared with the 5 before them — so one lucky run
              doesn&apos;t read as progress. These are game-score trends, not a measure of real-world ability.
            </p>
          </div>
        </div>

        {/* ── Skill Radar ── */}
        <div>
          <div className="section-label">Skill Profile</div>
          <div className="radar-wrap bg-[#12131c] border border-neutral-800 rounded-2xl p-4 relative overflow-hidden">
            <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-[#1a1b26] px-2 py-0.5 rounded-full border border-[#232433]">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">Calibration Grid</span>
            </div>
            {renderRadarChart(radarAxes)}
          </div>
        </div>

        {/* ── Consistency Heatmap ── */}
        <div>
          <div className="section-label">Consistency</div>
          <div className="bg-[#12131c] border border-neutral-800 rounded-2xl p-5">
            <div className="heatmap">
              {heatmapCells.map((cell, idx) => (
                <i key={idx} className={cell.levelClass} title={cell.title} />
              ))}
            </div>
            <div className="heatmap-legend">
              <span>Less</span>
              <i />
              <i className="l1" />
              <i className="l2" />
              <i className="l3" />
              <span>More</span>
            </div>
          </div>
        </div>

        {/* ── Achievements ── */}
        {achievements && (
          <div>
            <div className="section-label">Achievements · {achievements.earnedCount}/{achievements.total}</div>

            {achievements.next && (
              <div className="mb-3 rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-300">
                    <achievements.next.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white">Next: {achievements.next.name}</p>
                    <p className="text-[10.5px] text-slate-400">{achievements.next.requirement}</p>
                  </div>
                  <span className="shrink-0 text-[11px] font-black tabular-nums text-violet-300">
                    {achievements.next.current}/{achievements.next.target}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[.06]">
                  <div className="h-full bg-violet-500" style={{ width: `${Math.max(3, achievements.next.pct)}%` }} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              {achievements.list.map(a => (
                <div
                  key={a.id}
                  className={`flex items-center gap-2.5 rounded-xl border p-2.5 ${
                    a.earned ? 'border-amber-500/25 bg-amber-500/[0.06]' : 'border-[#232433] bg-[#12131c]'
                  }`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${a.earned ? 'text-amber-400' : 'text-slate-600'}`}>
                    {a.earned ? <a.icon className="h-4 w-4" /> : <Lock className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0">
                    <p className={`truncate text-[11px] font-bold ${a.earned ? 'text-white' : 'text-slate-300'}`}>{a.name}</p>
                    <p className="truncate text-[9.5px] tabular-nums text-slate-500">
                      {a.earned ? 'Earned' : `${a.current} / ${a.target} · ${a.short}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Account settings ── */}
        <div>
          <div className="section-label">Account & settings</div>
          <div className="acct-list">
            
            {/* Sound Toggle */}
            <div className="acct-row justify-between">
              <div className="flex items-center gap-3">
                {sound ? <Volume2 className="w-4 h-4 text-violet-400" /> : <VolumeOff className="w-4 h-4 text-neutral-500" />}
                <span>Sound Effects</span>
              </div>
              <button
                onClick={toggleSound}
                className="w-10 h-6 rounded-full transition-colors duration-200 relative cursor-pointer"
                style={{ background: sound ? '#6366f1' : 'rgba(255,255,255,0.1)' }}
              >
                <div
                  className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200"
                  style={{ transform: sound ? 'translateX(18px)' : 'translateX(2px)' }}
                />
              </button>
            </div>

            {/* Daily reminder — optional, at a time the player picks. Off ->
                nothing is scheduled; on -> a single notification for the next
                time the session is open (see lib/dailyReminder.js). */}
            <div className="acct-row justify-between">
              <div className="flex items-center gap-3">
                {reminder?.enabled ? <Bell className="w-4 h-4 text-violet-400" /> : <BellOff className="w-4 h-4 text-neutral-500" />}
                <div>
                  <span>Daily reminder</span>
                  {reminder?.enabled && (
                    <input
                      type="time"
                      value={reminderTimeValue}
                      onChange={(e) => changeReminderTime(e.target.value)}
                      className="ml-2 rounded-md border border-[#232433] bg-[#0e0f16] px-1.5 py-0.5 text-[11px] text-slate-200 focus:border-violet-500/50 focus:outline-none"
                      aria-label="Reminder time"
                    />
                  )}
                </div>
              </div>
              <button
                onClick={toggleReminder}
                disabled={!reminder}
                className="relative h-6 w-10 rounded-full transition-colors duration-200 disabled:opacity-40"
                style={{ background: reminder?.enabled ? '#6366f1' : 'rgba(255,255,255,0.1)' }}
              >
                <div
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                  style={{ transform: reminder?.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                />
              </button>
            </div>

            {/* Auth Session — user is always present here now that the whole app requires sign-in */}
            {user && (
              <button onClick={signOut} className="w-full text-left acct-row logout cursor-pointer hover:bg-white/[0.02]">
                <LogOut className="w-4 h-4 text-neutral-500" />
                <span>Log Out ({user.email})</span>
              </button>
            )}

            {/* "Reset Device Settings" removed. The only preference it
                cleared was the sound setting, which already has its own
                dedicated toggle — so the row was a second, more alarming way
                to do something the switch above does directly, sitting in a
                confirm() dialog next to the real destructive action. */}

            {/* Legal */}
            <Link href="/privacy" className="w-full text-left acct-row cursor-pointer hover:bg-white/[0.02]">
              <FileText className="w-4 h-4 text-neutral-500" />
              <span>Privacy Policy</span>
              <ChevronRight className="chev" />
            </Link>
            <Link href="/terms" className="w-full text-left acct-row cursor-pointer hover:bg-white/[0.02]">
              <FileText className="w-4 h-4 text-neutral-500" />
              <span>Terms of Service</span>
              <ChevronRight className="chev" />
            </Link>
          </div>

          {/* Delete Account (separated danger action) */}
          <button 
            onClick={handleDeleteAccount}
            className="w-full acct-row danger logout cursor-pointer hover:bg-red-500/[0.05] transition-colors"
          >
            <ShieldAlert className="w-4.5 h-4.5 text-red-400" />
            <span>Delete Account & Wipe Data</span>
          </button>
        </div>

        {/* App metadata.
            "SkillDrills Pro" was the last user-visible survivor of the old
            name — the launcher label, capacitor.config.js and the store
            listing all say "SkillDrills", and a name that doesn't match the
            listing is the sort of thing that gets queried in review.

            The claims underneath it are gone, because they were not true and
            not checkable:
              - "All data encrypted locally on your device" — solo progress
                goes to SharedPreferences via @capacitor/preferences, which is
                plain XML. Android encrypts the whole filesystem at the OS
                level, but that is the OS doing it for every app, not
                something this app implements, and claiming it as a feature is
                a security claim we cannot stand behind.
              - "Privacy-focused calibration" means nothing.
            What replaced them is only what the code actually does: solo
            progress is stored on-device (see lib/progressStore.js), and the
            account data that does leave the device is listed plainly. */}
        <div className="text-center py-4 text-[10px] text-neutral-600 space-y-1">
          <p>SkillDrills · Your drill progress stays on this device</p>
          <p>Only your name, photo and Arena record are stored online</p>
        </div>

      </div>

      {/* MODAL: Crop & confirm profile photo */}
      {photoFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-xs bg-[#0f1018] border border-[#232433] rounded-2xl p-6 shadow-2xl text-center">
            <h3 className="font-bold text-base text-white mb-4">Adjust Your Photo</h3>

            <div className="flex justify-center mb-4">
              <AvatarEditor
                ref={avatarEditorRef}
                image={photoFile}
                width={128}
                height={128}
                border={20}
                borderRadius={64}
                scale={photoScale}
                color={[0, 0, 0, 0.6]}
                rotate={0}
              />
            </div>

            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={photoScale}
              onChange={(e) => setPhotoScale(parseFloat(e.target.value))}
              className="w-full mb-4 accent-violet-500"
            />

            {photoError && (
              <p className="text-xs text-red-400 mb-3">{photoError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleCancelPhotoEdit}
                disabled={uploadingPhoto}
                className="flex-1 py-2.5 bg-[#1a1b26] hover:bg-[#232433] text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePhoto}
                disabled={uploadingPhoto}
                className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50 cursor-pointer"
              >
                {uploadingPhoto ? 'Saving...' : 'Save Photo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
