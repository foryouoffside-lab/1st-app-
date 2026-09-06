// lib/drillIndex.js
// SkillDrills Pro — Complete Drill Search Index
// Consolidated Cognitive Drills

export const DRILL_INDEX = [
  {
    id: 'multi-tasking',
    name: 'Multi-Tasking',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/attention/multi-tasking',
    emoji: '🎯',
    difficulty: 'advanced',
    keywords: ["multitask","multi","task","brain","dual","simultaneous","cognitive","split","focus"],
  },
  {
    id: 'concentration-grid',
    name: 'Concentration Grid',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/focus/concentration-grid',
    emoji: '🔷',
    difficulty: 'beginner',
    keywords: ["concentration","grid","focus","number","scan","visual","brain","search","find"],
  },
  {
    id: 'distraction-fighter',
    name: 'Distraction Fighter',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/focus/distraction-fighter',
    emoji: '🛡️',
    difficulty: 'impossible',
    keywords: ["distraction","fighter","focus","ignore","noise","filter","brain","concentration"],
  },
  {
    id: 'shade-finder',
    name: 'Shade Finder',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/focus/shade-finder',
    emoji: '🎨',
    difficulty: 'intermediate',
    keywords: ["shade","finder","color","vision","different","square","odd-one-out","focus","concentration"],
  },
  {
    id: 'moving-target',
    name: 'Moving Target',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/focus/moving-target',
    emoji: '🎯',
    difficulty: 'beginner',
    keywords: ["moving","target","tracking","visual","follow","tap","click","aim","accuracy"],
  },
  {
    id: 'card-matching',
    name: 'Card Matching',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/memory/card-matching',
    emoji: '🃏',
    difficulty: 'beginner',
    keywords: ["card","matching","memory","pair","flip","brain","recall","visual","concentration"],
  },
  {
    id: 'grid-memorization',
    name: 'Grid Memorization',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/memory/grid-memorization',
    emoji: '🔷',
    difficulty: 'advanced',
    keywords: ["grid","memorization","spatial","memory","position","location","visual","brain","map"],
  },
  {
    id: 'tower-of-hanoi',
    name: 'Tower of Hanoi',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/problem-solving/tower-of-hanoi',
    emoji: '🗼',
    difficulty: 'intermediate',
    keywords: ["tower","hanoi","puzzle","brain","recursive","logic","stack","move","solve"],
  },
  {
    id: 'finger-sequencing',
    name: 'Finger Sequencing',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/processing-speed/finger-sequencing',
    emoji: '🤙',
    difficulty: 'intermediate',
    keywords: ["finger","sequence","motor","dexterity","tap","order","pattern","hand","speed"],
  },
  {
    id: 'quick-dodge',
    name: 'Quick Dodge',
    category: 'Cognitive',
    categorySlug: 'cognitive',
    path: '/drills/cognitive/processing-speed/quick-dodge',
    emoji: '🏃',
    difficulty: 'intermediate',
    keywords: ["quick","dodge","reflex","physical","evade","avoid","reaction","fast","body"],
  },
];


// ============================================================
// ENGAGEMENT ORDER
// ============================================================
// The order the hub lists drills in, most engaging first.
//
// Not difficulty and not alphabetical: this is "how likely is a new user to
// play a second round after trying this one". Arcade-feeling drills with
// motion, a clear goal in the first two seconds, and a visible fail state sit
// at the top. Benchmark-style tests (stare, wait, tap once) and slow puzzles
// that fight the 45s clock sit at the bottom — they are still worth training
// with, they are just a bad first impression.
//
// The list is the single source of truth for the ranking; anything missing
// from it falls to the end rather than disappearing, so adding a new drill to
// DRILL_INDEX can never make it vanish from the hub.
export const ENGAGEMENT_ORDER = [
  'quick-dodge',
  'distraction-fighter',
  'card-matching',
  'multi-tasking',
  'moving-target',
  'grid-memorization',
  'shade-finder',
  'tower-of-hanoi',
  'concentration-grid',
  'finger-sequencing',
];

const ENGAGEMENT_RANK = new Map(ENGAGEMENT_ORDER.map((id, i) => [id, i]));

// Comparator for Array.prototype.sort over DRILL_INDEX entries.
export function byEngagement(a, b) {
  const ra = ENGAGEMENT_RANK.has(a.id) ? ENGAGEMENT_RANK.get(a.id) : Number.MAX_SAFE_INTEGER;
  const rb = ENGAGEMENT_RANK.has(b.id) ? ENGAGEMENT_RANK.get(b.id) : Number.MAX_SAFE_INTEGER;
  return ra - rb;
}

// ============================================================
// HUB CATALOG
// ============================================================
// Every drill gets its own row. Three pairs used to be folded together behind
// "tier" chips on a single card (Moving Target / Visual Tracking Speed Test,
// Reaction Time Test / Reflex Training, Batch Processing / Selective
// Attention) because they play alike. That read worse than the padding it was
// meant to hide: a card with two buttons under it looked broken next to the
// plain cards around it, and the second drill was invisible unless you noticed
// the chip. They are separate entries again — each has its own preview frame,
// its own progress and its own place in the engagement order, so the hub
// renders DRILL_INDEX directly and there is no merge step left to drift.
