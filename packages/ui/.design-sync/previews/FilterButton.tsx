import React, { useState } from 'react';
import { FilterButton } from '@crewly/ui';
import type { FilterValue } from '@crewly/ui';

const groups = [
  { id: 'status', label: 'Status', options: [{ value: 'running', label: 'Running', count: 3 }, { value: 'queued', label: 'Queued', count: 5 }, { value: 'failed', label: 'Failed', count: 1 }] },
  { id: 'team', label: 'Team', options: [{ value: 'growth', label: 'Growth' }, { value: 'think-tank', label: 'Think Tank' }] },
];

export const WithActiveChips = () => {
  const [value, setValue] = useState<FilterValue>({ status: ['running'], team: ['growth'] });
  return (
    <div className="h-80 w-[640px]">
      <FilterButton groups={groups} value={value} onChange={setValue} defaultOpen />
    </div>
  );
};
