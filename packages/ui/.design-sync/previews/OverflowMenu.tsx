import React from 'react';
import { OverflowMenu } from '@crewly/ui';

// The menu opens on click; the static card shows the trigger in context.
export const InARow = () => (
  <div className="w-96 flex items-center justify-between rounded-2xl border border-border-dark bg-surface-dark px-4 py-3">
    <span className="text-sm font-semibold">Growth team</span>
    <OverflowMenu items={[{ label: 'Rename', onClick: () => {} }, { label: 'Delete', onClick: () => {}, danger: true }]} />
  </div>
);
