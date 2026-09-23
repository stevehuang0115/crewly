import React from 'react';
import { Tabs, TabList, TabTrigger, TabContent } from '@crewly/ui';

export const ShownForActiveTab = () => (
  <div className="w-[480px]">
    <Tabs defaultValue="notes">
      <TabList>
        <TabTrigger value="notes">Notes</TabTrigger>
        <TabTrigger value="history">History</TabTrigger>
      </TabList>
      <TabContent value="notes">
        <p className="text-sm text-text-secondary-dark">Atlas summarised today's #daily-info: two posts worth a deeper look.</p>
      </TabContent>
      <TabContent value="history"><p className="text-sm">History</p></TabContent>
    </Tabs>
  </div>
);
