import React from 'react';
import { SegmentedControl } from '@crewly/ui';
import { LayoutGrid, List } from 'lucide-react';

export const ViewMode = () => (
  <SegmentedControl
    aria-label="View"
    value="grid"
    onChange={() => {}}
    options={[{ value: 'grid', label: 'Grid', icon: LayoutGrid }, { value: 'list', label: 'List', icon: List }]}
  />
);

export const Range = () => (
  <SegmentedControl
    aria-label="Range"
    size="sm"
    value="week"
    onChange={() => {}}
    options={[{ value: 'day', label: 'Today' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'year', label: 'Year', disabled: true }]}
  />
);

export const FullWidth = () => (
  <div className="w-80">
    <SegmentedControl aria-label="Input" fullWidth value="tap" onChange={() => {}} options={[{ value: 'tap', label: 'Tap' }, { value: 'mouse', label: 'Mouse' }]} />
  </div>
);
