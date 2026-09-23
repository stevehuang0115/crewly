import React from 'react';
import { PageToolbar, Button } from '@crewly/ui';
import { LayoutGrid, List, Plus } from 'lucide-react';

export const Full = () => (
  <div className="w-full">
    <PageToolbar
      tabs={[
        { value: 'all', label: 'All', count: 12 },
        { value: 'running', label: 'Running', count: 4 },
        { value: 'stopped', label: 'Stopped', count: 8 },
      ]}
      activeTab="running"
      onTabChange={() => {}}
      searchPlaceholder="Search teams"
      onSearchChange={() => {}}
      viewModes={[
        { value: 'grid', label: 'Grid', icon: <LayoutGrid className="w-4 h-4" /> },
        { value: 'list', label: 'List', icon: <List className="w-4 h-4" /> },
      ]}
      activeViewMode="grid"
      onViewModeChange={() => {}}
      trailing={<Button size="sm" icon={Plus}>New team</Button>}
    />
  </div>
);

export const TabsOnly = () => (
  <div className="w-full">
    <PageToolbar
      tabs={[
        { value: 'open', label: 'Open', count: 7 },
        { value: 'done', label: 'Done', count: 31 },
      ]}
      activeTab="open"
      onTabChange={() => {}}
    />
  </div>
);
