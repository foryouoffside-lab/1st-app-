'use client';

// app/progress/ProgressClient.js
// SkillDrills Pro — Personal Progress Screen
// Shows: Level/XP, streak, top scores, settings, data management

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import AvatarEditor from 'react-avatar-editor';
import {
  BarChart3, Trophy, Flame, Zap, Target, Star,
  Trash2, Volume2, VolumeOff, ChevronRight, Award,
  LogOut, User, ShieldAlert, Camera, FileText
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { doc, updateDoc } from 'firebase/firestore';
import { 
  getStreak, getPlayerLevel, getTotalSessions, getDrillsPlayed, 
  getTopScores, clearAllProgress, getSettings, updateSettings 
} from '../../lib/progressStore';
import { Storage } from '../../lib/storage';
import { DRILL_INDEX } from '../../lib/drillIndex';
import { RANK_TIERS, getRankTier } from '../../lib/leaderboard';
import { DRILL_GROUPS, getDrillGroup } from '../../lib/drillGroups';

const RADAR_CATEGORIES = DRILL_GROUPS.map(g => ({ slug: g.id, name: g.name }));

export default function ProgressClient() {
  const { user, db, signOut, deleteAccount } = useAuth();
  const [photoFile, setPhotoFile] = useState(null);
  const [photoScale, setPhotoScale] = useState(1.2);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const avatarEditorRef = useRef(null);
  const fileInputRef = useRef(null);
  const [level,    setLevel]    = useState(1);
  const [xpIn,     setXpIn]     = useState(0);
  const [xpTo,     setXpTo]     = useState(1000);
  const [totalXP,  setTotalXP]  = useState(0);
  const [streak,   setStreak]   = useState({ current: 0, longest: 0 });
  const [sessions, setSessions] = useState(0);
  const [drillsP,  setDrillsP]  = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [topScores,setTopScores]= useState([]);
  const [sound,    setSound]    = useState(true);
  const [cleared,  setCleared]  = useState(false);

  const [guestName, setGuestName] = useState('Guest Player');
  const [editingName, setEditingName] = useState(false);
  const [tempName, setTempName] = useState('');

  const [radarAxes, setRadarAxes] = useState([]);
  const [heatmapCells, setHeatmapCells] = useState([]);
  const [unlockedBadges, setUnlockedBadges] = useState(new Set());

  const displayName = user?.displayName || guestName;

  useEffect(() => {
    async function load() {
      const [lv, s, sess, dp, ts, settings, history, scores] = await Promise.all([
        getPlayerLevel(), getStreak(), getTotalSessions(),
        getDrillsPlayed(), getTopScores(10), getSettings(),
        Storage.getJSON('sd_history', {}), Storage.getJSON('sd_scores', {})
      ]);

      setLevel(lv.level);
      setXpIn(lv.xpInLevel);
      setXpTo(lv.xpToNext);
      setTotalXP(lv.xp);
      setStreak(s);
      setSessions(sess);
      setDrillsP(dp);
      setTopScores(ts);
      setSound(settings.soundEnabled ?? true);

      // Load guest name
      if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('sd_guest_name');
        if (saved) setGuestName(saved);
      }

      // Calculate best combo from history
      const maxCombo = Object.values(history || {}).reduce((max, list) => {
        const listMax = list.reduce((m, item) => Math.max(m, item.combo || 0), 0);
        return Math.max(max, listMax);
      }, 0);
      setBestCombo(maxCombo);

      // Calculate radar chart axes
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
        return {
          ...c,
          value,
          totalSessions: stats.totalSessions
        };
      }).filter(axis => axis.totalSessions > 0);

      let finalAxes = [...activeAxes];
      if (finalAxes.length < 3) {
        const defaults = ['fps', 'cognitive', 'memory'];
        defaults.forEach(slug => {
          if (!finalAxes.some(a => a.slug === slug)) {
            const cat = RADAR_CATEGORIES.find(c => c.slug === slug);
            finalAxes.push({
              ...cat,
              value: 0,
              totalSessions: 0
            });
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

      // Calculate unlocked badges based on best scores
      const unlocked = new Set();
      ts.forEach(item => {
        const pct = Math.min(100, Math.round(item.best / 10));
        const tier = getRankTier(pct);
        if (tier) unlocked.add(tier.id);
      });
      setUnlockedBadges(unlocked);
    }
    load();
  }, [cleared]);

  async function toggleSound() {
    const next = !sound;
    setSound(next);
    await updateSettings({ soundEnabled: next });
  }

  const handleEditName = () => {
    setTempName(displayName);
    setEditingName(true);
  };

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    try {
      if (user && db) {
        const userRef = doc(db, 'users', user.uid);
        await updateDoc(userRef, { displayName: tempName.trim() });
        user.displayName = tempName.trim();
        localStorage.setItem('sd_user_session', JSON.stringify(user));
      } else {
        localStorage.setItem('sd_guest_name', tempName.trim());
      }
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
  // document limit is 1MB; a 128x128 JPEG is nowhere close (typically
  // 10-25KB as base64), and firestore.rules independently caps this field
  // at 300KB as a backstop, since every other player's leaderboard/online
  // list read pulls this field along with the rest of the profile.
  const DATA_URL_SAFETY_LIMIT = 280000; // stay under the 300KB rule cap

  const handleSavePhoto = async () => {
    if (!avatarEditorRef.current || !user || !db) return;
    setUploadingPhoto(true);
    setPhotoError('');
    try {
      const canvas = avatarEditorRef.current.getImageScaledToCanvas();
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      if (dataUrl.length > DATA_URL_SAFETY_LIMIT) {
        throw new Error('too-large');
      }

      await updateDoc(doc(db, 'users', user.uid), { photoURL: dataUrl });
      user.photoURL = dataUrl;
      localStorage.setItem('sd_user_session', JSON.stringify(user));

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
        <h1 className="text-2xl font-black text-white">Your Progress</h1>

        {/* ── Profile Hero ── */}
        <div className="p-hero">
          <div className="relative flex-shrink-0">
            {user?.photoURL ? (
              <img
                src={user.photoURL}
                alt={displayName}
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
                className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-violet-600 hover:bg-violet-500 border-2 border-[#0a0a12] flex items-center justify-center cursor-pointer transition-colors"
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
                  className="bg-neutral-800 border border-neutral-700 rounded-lg px-2.5 py-1 text-sm font-bold text-white max-w-[140px] focus:outline-none focus:border-violet-500"
                  autoFocus
                />
                <button onClick={handleSaveName} className="text-xs bg-emerald-400 text-black px-2.5 py-1.5 rounded-lg font-black transition hover:bg-emerald-300">Save</button>
                <button onClick={() => setEditingName(false)} className="text-xs bg-neutral-700 text-white px-2.5 py-1.5 rounded-lg font-bold">Cancel</button>
              </div>
            ) : (
              <>
                <b>{displayName}</b>
                <span>Level {level} · {drillsP} drills played</span>
              </>
            )}
          </div>
          {!editingName && (
            <button className="p-edit cursor-pointer" onClick={handleEditName}>Edit Profile</button>
          )}
        </div>

        {/* ── Level Progress ── */}
        <div className="p-xp">
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
        </div>

        {/* ── Stats ── */}
        <div className="p-stats">
          <div>
            <b>{drillsP}</b>
            <span>Drills Played</span>
          </div>
          <div>
            <b>{streak.current}d</b>
            <span>Day Streak</span>
          </div>
          <div>
            <b>{bestCombo}</b>
            <span>Best Combo</span>
          </div>
          <div>
            <b>{sessions}</b>
            <span>Total Sessions</span>
          </div>
        </div>

        {/* ── Skill Radar ── */}
        <div>
          <div className="section-label">Skill Profile</div>
          <div className="radar-wrap bg-[#12131c] border border-neutral-800 rounded-3xl p-4 relative overflow-hidden">
            <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-neutral-900/40 px-2 py-0.5 rounded-full border border-neutral-800">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
              <span className="text-[9px] text-neutral-400 font-bold uppercase tracking-wider">Calibration Grid</span>
            </div>
            {renderRadarChart(radarAxes)}
          </div>
        </div>

        {/* ── Consistency Heatmap ── */}
        <div>
          <div className="section-label">Consistency</div>
          <div className="bg-[#12131c] border border-neutral-800 rounded-3xl p-5">
            <div className="heatmap">
              {heatmapCells.map((cell, idx) => (
                <i 
                  key={idx} 
                  className={cell.levelClass} 
                  title={cell.title} 
                />
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

        {/* ── Achievements Badges ── */}
        <div>
          <div className="section-label">Achievements</div>
          <div className="p-badges">
            {RANK_TIERS.map(tier => {
              const isUnlocked = unlockedBadges.has(tier.id) || (tier.id === 'practice' && drillsP > 0);
              return (
                <span 
                  key={tier.id} 
                  className={`p-badge ${tier.bg} ${tier.border} ${tier.color} border transition duration-200 ${isUnlocked ? 'opacity-100' : 'opacity-25'}`}
                  title={isUnlocked ? `Unlocked! Achieved on a drill.` : `Locked. Achieve ${tier.minScore}% to unlock.`}
                >
                  <span>{tier.icon}</span>
                  <span>{tier.name}</span>
                </span>
              );
            })}
          </div>
        </div>

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

            {/* Auth Session — user is always present here now that the whole app requires sign-in */}
            {user && (
              <button onClick={signOut} className="w-full text-left acct-row logout cursor-pointer hover:bg-white/[0.02]">
                <LogOut className="w-4 h-4 text-neutral-500" />
                <span>Log Out ({user.email})</span>
              </button>
            )}

            {/* Reset Settings */}
            <button 
              onClick={() => {
                if (confirm("Reset device preferences? This will reset your sound settings.")) {
                  localStorage.removeItem('sd_settings');
                  setCleared(c => !c);
                }
              }}
              className="w-full text-left acct-row cursor-pointer hover:bg-white/[0.02]"
            >
              <Trash2 className="w-4 h-4 text-neutral-500" />
              <span>Reset Device Settings</span>
              <ChevronRight className="chev" />
            </button>

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

        {/* App metadata */}
        <div className="text-center py-4 text-[10px] text-neutral-600 space-y-1">
          <p>SkillDrills Pro · All data encrypted locally on your device</p>
          <p>No cross-site tracking · Privacy-focused calibration</p>
        </div>

      </div>

      {/* MODAL: Crop & confirm profile photo */}
      {photoFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-xs bg-[#0a0a12] border border-neutral-800 rounded-3xl p-6 shadow-2xl text-center">
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
                className="flex-1 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50 cursor-pointer"
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
