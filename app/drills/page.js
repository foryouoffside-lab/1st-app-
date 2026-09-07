'use client';

// app/drills/page.js
// The drill catalogue lives on the home screen now — there is no separate
// hub index. Anything landing on /drills goes home.

import { redirect } from 'next/navigation';

export default function DrillsPage() {
  redirect('/');
}
