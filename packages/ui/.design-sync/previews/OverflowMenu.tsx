import React from 'react';
import { OverflowMenu } from '@crewly/ui';
import { MoreHorizontal, BellOff, SkipForward } from 'lucide-react';

// The menu opens on click; the static card shows the trigger in context.
export const InARow = () => (
  <div className="w-96 flex items-center justify-between rounded-2xl border border-border-dark bg-surface-dark px-4 py-3">
    <span className="text-sm font-semibold">Growth team</span>
    <OverflowMenu items={[{ label: 'Rename', onClick: () => {} }, { label: 'Delete', onClick: () => {}, danger: true }]} />
  </div>
);

// Redesign "⋯" with the menu drawn open (defaultOpen), as on the artboards.
export const OpenHorizontal = () => {
  return (
    <div className="h-40 w-96 flex items-start justify-between rounded-2xl bg-surface px-4 py-3">
      <span className="text-[15px] font-semibold">Ship the pricing page?</span>
      <OverflowMenu
        defaultOpen
        icon={MoreHorizontal}
        label="More answers"
        items={[
          { label: 'Reply in thread', onClick: () => {} },
          { label: 'Remind me tomorrow', icon: BellOff, onClick: () => {} },
          { label: 'Skip', icon: SkipForward, onClick: () => {}, separator: true },
        ]}
      />
    </div>
  );
};
