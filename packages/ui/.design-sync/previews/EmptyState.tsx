import React from 'react';
import { EmptyState, Button } from '@crewly/ui';
import { Users, Inbox, Plus } from 'lucide-react';

export const WithAction = () => (
  <div className="w-[520px] rounded-2xl border border-border-dark">
    <EmptyState icon={Users} title="No teams yet" description="A team is a group of agents that share a Slack channel and a project." action={<Button icon={Plus}>New team</Button>} />
  </div>
);

export const Compact = () => (
  <div className="w-80 rounded-2xl border border-border-dark bg-surface-dark">
    <EmptyState compact icon={Inbox} title="Nothing waiting for you" description="Approvals show up here." />
  </div>
);
