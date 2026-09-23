import React from 'react';
import { Tabs, TabList, TabTrigger } from '@crewly/ui/Tabs';
import { ActiveTab, ScheduledMessage } from './types';

interface TabNavigationProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  activeMessages: ScheduledMessage[];
  completedMessages: ScheduledMessage[];
}

/**
 * Active / Completed tab strip for scheduled messages (controlled by the parent).
 *
 * @param props - Active tab, setter and the two lists (for counts)
 * @returns The tab strip
 */
export const TabNavigation: React.FC<TabNavigationProps> = ({
  activeTab,
  setActiveTab,
  activeMessages,
  completedMessages
}) => {
  return (
    <Tabs value={activeTab} onValueChange={(tab) => setActiveTab(tab as ActiveTab)}>
      <TabList aria-label="Tabs">
        <TabTrigger value="active">Active ({activeMessages.length})</TabTrigger>
        <TabTrigger value="completed">Completed ({completedMessages.length})</TabTrigger>
      </TabList>
    </Tabs>
  );
};
