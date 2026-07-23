'use client';

import dynamic from 'next/dynamic';

const ReactionTimeTestClient = dynamic(
  () => import('./ReactionTimeTestClient'),
  { ssr: false }
);

export default function ReactionTimeTestWrapper() {
  return <ReactionTimeTestClient />;
}
