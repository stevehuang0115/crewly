import React from 'react';
import { StatusBadge } from '@crewly/ui';

export const AllStatuses = () => (
  <div className="flex flex-wrap gap-2 w-[520px]">
    {(['active', 'running', 'pending', 'paused', 'completed', 'blocked', 'error', 'stopped', 'inactive', 'suspended'] as const).map((s) => (
      <StatusBadge key={s} status={s} />
    ))}
  </div>
);

export const CustomLabel = () => <StatusBadge status="running">3 agents working</StatusBadge>;
