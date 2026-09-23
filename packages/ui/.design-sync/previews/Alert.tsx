import React from 'react';
import { Alert } from '@crewly/ui';

export const Info = () => (
  <div className="w-[520px]">
    <Alert variant="info" title="Orchestrator is restarting">
      Messages sent in the next minute are queued and delivered once it is back.
    </Alert>
  </div>
);

export const Variants = () => (
  <div className="w-[520px] space-y-3">
    <Alert variant="success" title="Team started">Ella, Atlas and Leo are online.</Alert>
    <Alert variant="warning" title="Approval needed">Leo wants to publish a post to the company blog.</Alert>
    <Alert variant="error" title="Slack disconnected">The bot token was revoked. Reconnect Slack in Settings.</Alert>
    <Alert variant="info">Crewly 1.20.101 is available.</Alert>
  </div>
);

export const Dismissible = () => (
  <div className="w-[520px]">
    <Alert variant="warning" title="Chrome extension offline" onClose={() => {}}>
      Agents cannot use the browser until the extension reconnects.
    </Alert>
  </div>
);
