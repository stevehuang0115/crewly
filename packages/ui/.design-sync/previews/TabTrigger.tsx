import React from 'react';
import { Tabs, TabList, TabTrigger } from '@crewly/ui';
import { MessageSquare, Lock } from 'lucide-react';

export const ActiveInactiveDisabled = () => (
  <div className="w-[480px]">
    <Tabs defaultValue="chat">
      <TabList>
        <TabTrigger value="chat" icon={<MessageSquare className="w-4 h-4" />}>Chat</TabTrigger>
        <TabTrigger value="logs">Logs</TabTrigger>
        <TabTrigger value="secrets" icon={<Lock className="w-4 h-4" />} disabled>Secrets</TabTrigger>
      </TabList>
    </Tabs>
  </div>
);
