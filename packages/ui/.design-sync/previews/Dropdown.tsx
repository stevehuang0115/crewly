import React from 'react';
import { Dropdown } from '@crewly/ui';

const runtimes = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'crewly-agent', label: 'Crewly agent (DeepSeek)', disabled: true },
];

export const Selected = () => (
  <div className="w-72"><Dropdown options={runtimes} value="claude-code" aria-label="Runtime" /></div>
);

export const Placeholder = () => (
  <div className="w-72"><Dropdown options={runtimes} placeholder="Choose a runtime" aria-label="Runtime" /></div>
);

export const States = () => (
  <div className="w-72 flex flex-col items-start gap-3">
    <Dropdown options={runtimes} placeholder="Error" error aria-label="Runtime" />
    <Dropdown options={runtimes} value="codex" disabled aria-label="Runtime" />
    <Dropdown options={runtimes} placeholder="Loading runtimes" loading aria-label="Runtime" />
  </div>
);
