import React from 'react';
import { Tabs, TabList, TabTrigger, TabContent } from '@crewly/ui';
import { Users, ListTodo, Settings } from 'lucide-react';

export const TeamDetail = () => (
  <div className="w-[520px]">
    <Tabs defaultValue="members">
      <TabList>
        <TabTrigger value="members" icon={<Users className="w-4 h-4" />}>Members</TabTrigger>
        <TabTrigger value="tasks" icon={<ListTodo className="w-4 h-4" />}>Tasks</TabTrigger>
        <TabTrigger value="settings" icon={<Settings className="w-4 h-4" />}>Settings</TabTrigger>
      </TabList>
      <TabContent value="members">
        <p className="text-sm text-text-secondary-dark">Ella (team lead), Atlas (researcher) and Leo (writer) are on this team.</p>
      </TabContent>
      <TabContent value="tasks"><p className="text-sm">3 open tasks</p></TabContent>
      <TabContent value="settings"><p className="text-sm">Team settings</p></TabContent>
    </Tabs>
  </div>
);

export const WithDisabledTab = () => (
  <div className="w-[520px]">
    <Tabs defaultValue="overview">
      <TabList>
        <TabTrigger value="overview">Overview</TabTrigger>
        <TabTrigger value="activity">Activity</TabTrigger>
        <TabTrigger value="billing" disabled>Billing</TabTrigger>
      </TabList>
      <TabContent value="overview">
        <p className="text-sm text-text-secondary-dark">Two agents are running; one is waiting for your approval.</p>
      </TabContent>
    </Tabs>
  </div>
);
