'use client';

import dynamic from 'next/dynamic';

const VisualTrackingSpeedTestClient = dynamic(
  () => import('./VisualTrackingSpeedTestClient'),
  { ssr: false }
);

export default function VisualTrackingSpeedTestWrapper() {
  return <VisualTrackingSpeedTestClient />;
}
