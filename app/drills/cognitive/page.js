import { Suspense } from 'react';
import CognitiveHubClient from './CognitiveHubClient';

export default function CognitiveDrillsPage() {
  return (
    <Suspense fallback={null}>
      <CognitiveHubClient />
    </Suspense>
  );
}
