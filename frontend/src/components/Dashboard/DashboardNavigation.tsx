import React from 'react';
import { Tabs, TabList, TabTrigger } from '@crewly/ui/Tabs';
import { DashboardNavigationProps } from './types';

const TABS = ['overview', 'teams', 'terminal'] as const;

/**
 * Tab strip for the legacy dashboard (controlled by the parent).
 *
 * @param props - Active tab and change handler
 * @returns The navigation tab strip
 */
export const DashboardNavigation: React.FC<DashboardNavigationProps> = ({
  activeTab,
  onTabChange
}) => {
  return (
    <nav className="bg-surface-dark">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <Tabs
          value={activeTab}
          onValueChange={(tab) => onTabChange(tab as (typeof TABS)[number])}
        >
          <TabList aria-label="Dashboard sections" className="!mb-0">
            {TABS.map((tab) => (
              <TabTrigger key={tab} value={tab}>
                <span className="capitalize">{tab}</span>
              </TabTrigger>
            ))}
          </TabList>
        </Tabs>
      </div>
    </nav>
  );
};
