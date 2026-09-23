import React from 'react';
import { FilterPillGroup } from '@crewly/ui';

export const Status = () => (
  <FilterPillGroup
    label="Status"
    value="open"
    onChange={() => {}}
    options={[
      { key: 'all', label: 'All', count: 18 },
      { key: 'open', label: 'Open', count: 7 },
      { key: 'done', label: 'Done', count: 11 },
    ]}
  />
);

export const WithoutLabel = () => (
  <FilterPillGroup
    value="week"
    onChange={() => {}}
    options={[
      { key: 'day', label: 'Today' },
      { key: 'week', label: 'This week' },
      { key: 'month', label: 'This month' },
    ]}
  />
);
