'use client';

import dynamic from 'next/dynamic';

const ReflexTrainingDrillClient = dynamic(
  () => import('./ReflexTrainingDrillClient'),
  { ssr: false }
);

export default function ReflexTrainingDrillWrapper() {
  return <ReflexTrainingDrillClient />;
}
