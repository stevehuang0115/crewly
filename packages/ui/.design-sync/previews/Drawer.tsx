import React from 'react';
import { Drawer, Button, Badge } from '@crewly/ui';

export const AgentDetail = () => (
  <div className="h-[460px]">
    <Drawer
      isOpen
      onClose={() => {}}
      title="Ella"
      subtitle="Team lead · Personal assistant team"
      footer={<><Button variant="ghost">Close</Button><Button>Open chat</Button></>}
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between"><span className="text-text-secondary-dark">Status</span><Badge variant="success">Running</Badge></div>
        <div className="flex items-center justify-between"><span className="text-text-secondary-dark">Runtime</span><span>Claude Code</span></div>
        <div className="flex items-center justify-between"><span className="text-text-secondary-dark">Machine</span><span>MacBook Pro</span></div>
      </div>
    </Drawer>
  </div>
);
