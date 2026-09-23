import React from 'react';
import { Tabs, TabList, TabTrigger } from '@crewly/ui';

export const InsideTabs = () => (
  <div className="w-[480px]">
    <Tabs defaultValue="chat">
      <TabList>
        <TabTrigger value="chat">Chat</TabTrigger>
        <TabTrigger value="tasks">Tasks</TabTrigger>
        <TabTrigger value="files">Files</TabTrigger>
      </TabList>
    </Tabs>
  </div>
);
