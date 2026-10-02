import React from 'react';
import { SystemStatusBar, Button } from '@crewly/ui';
import { KeyRound, ArrowUpCircle, Gauge } from 'lucide-react';

export const SeveralProblems = () => (
  <div className="w-[880px]">
    <SystemStatusBar
      items={[
        { id: 'update', tone: 'primary', icon: ArrowUpCircle, title: 'Update available', message: 'Crewly 1.21.0 is out (you have 1.20.190).', actions: <Button size="xs" variant="link">Upgrade</Button>, onDismiss: () => {} },
        { id: 'login', tone: 'attention', icon: KeyRound, title: '1 agent needs you to sign in', message: 'Its AI runtime is waiting for an account login.', actions: <Button size="xs" variant="secondary">Sign in</Button>, onDismiss: () => {} },
        { id: 'usage', tone: 'attention', icon: Gauge, title: 'Claude Code is out of usage', message: 'Resets ~3:00 PM. 2 agents moved to Codex until then.', actions: <Button size="xs" variant="link">Runtimes</Button> },
      ]}
    />
  </div>
);

export const OrchestratorDown = () => (
  <div className="w-[880px]">
    <SystemStatusBar items={[{ id: 'orc', tone: 'danger', title: 'Orchestrator not running', message: 'Check the application logs for issues.', onDismiss: () => {} }]} />
  </div>
);
