import React from 'react';
import { StatusDot } from '@crewly/ui';

const all = ['online', 'active', 'connecting', 'paired', 'waiting', 'offline', 'disconnected', 'inactive', 'error'] as const;

export const Statuses = () => (
  <div className="grid grid-cols-3 gap-3 w-[420px]">
    {all.map((s) => (
      <div key={s} className="flex items-center gap-2 text-sm">
        <StatusDot status={s} /> <span className="text-text-secondary-dark">{s}</span>
      </div>
    ))}
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-4">
    <StatusDot status="online" size="sm" />
    <StatusDot status="online" size="md" />
    <StatusDot status="online" size="lg" />
    <span className="text-sm text-text-secondary-dark">sm · md · lg</span>
  </div>
);

export const InContext = () => (
  <div className="flex items-center gap-2 text-sm">
    <StatusDot status="connecting" pulse /> Chrome extension connecting…
  </div>
);
