import React from 'react';
import { CompactRow, Button, StatusLabel } from '@crewly/ui';

export const Decisions = () => (
  <div className="w-[720px] rounded-2xl bg-surface">
    <CompactRow
      primary="Ship the pricing page to production?"
      meta="Ella · Growth · 2h ago"
      actions={[<Button key="y" size="xs">Yes</Button>, <Button key="n" size="xs" variant="secondary">No</Button>]}
      overflow={[
        { label: 'Reply in thread', onClick: () => {} },
        { label: 'Remind me tomorrow', onClick: () => {} },
        { label: 'Skip', onClick: () => {}, separator: true },
      ]}
    />
    <CompactRow
      primary="Use DeepSeek for the nightly digest?"
      meta="Atlas · Think Tank · 5h ago"
      actions={[<Button key="y" size="xs">Yes</Button>, <Button key="n" size="xs" variant="secondary">No</Button>]}
      overflow={[{ label: 'Remind me tomorrow', onClick: () => {} }]}
    />
  </div>
);

export const Runs = () => (
  <div className="w-[720px] rounded-2xl bg-surface">
    <CompactRow onClick={() => {}} primary="CE-81 · Write the pricing copy" meta="Leo · Growth · started 12m ago" trailing={<StatusLabel tone="primary" pulse>Running</StatusLabel>} />
    <CompactRow onClick={() => {}} primary="CE-79 · Fix the signup email" meta="Nova · Ops · 1h ago" trailing={<StatusLabel tone="danger">Failed</StatusLabel>} />
    <CompactRow onClick={() => {}} primary="CE-77 · Weekly report" meta="Ella · Growth · yesterday" trailing={<StatusLabel tone="success">Done</StatusLabel>} />
  </div>
);
