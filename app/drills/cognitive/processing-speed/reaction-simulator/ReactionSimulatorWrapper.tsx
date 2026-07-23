'use client';

import dynamic from 'next/dynamic';

const ReactionSimulatorClient = dynamic(
  () => import('./ReactionSimulatorClient'),
  { ssr: false }
);

export default function ReactionSimulatorWrapper() {
  return <ReactionSimulatorClient />;
}
