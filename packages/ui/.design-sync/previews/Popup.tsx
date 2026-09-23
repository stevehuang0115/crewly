import React from 'react';
import { Popup, Button } from '@crewly/ui';

export const WithFooter = () => (
  <div className="h-[460px]">
  <Popup
    isOpen
    onClose={() => {}}
    title="Connect Slack"
    subtitle="Agents post in your team channels."
    footer={<><Button variant="ghost">Later</Button><Button>Connect</Button></>}
  >
    <p className="text-sm text-text-secondary-dark">You'll be sent to Slack to approve the Crewly app for your workspace.</p>
  </Popup>
  </div>
);
