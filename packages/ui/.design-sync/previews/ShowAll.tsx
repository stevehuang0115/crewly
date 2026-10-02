import React from 'react';
import { ShowAll, CompactRow } from '@crewly/ui';

const asks = ['Ship the pricing page?', 'Approve the July budget?', 'Merge the onboarding PR?', 'Post the launch thread?', 'Pause the cold-email run?', 'Renew the domain?', 'Hire a second writer?', 'Archive old tickets?'];

export const Collapsed = () => (
  <div className="w-[640px] rounded-2xl bg-surface pb-2">
    <ShowAll limit={5}>
      {asks.map((a) => <CompactRow key={a} primary={a} meta="Ella · Growth · 2h ago" />)}
    </ShowAll>
  </div>
);
