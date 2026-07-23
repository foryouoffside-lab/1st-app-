'use client';

// app/drills/page.js
// SkillDrills Pro — Redirects drills directory index to the consolidated cognitive sector.

import { redirect } from 'next/navigation';

export default function DrillsPage() {
  redirect('/drills/cognitive');
}