import React from 'react';
import { Input } from '@crewly/ui';

export const WithLabel = () => (
  <div className="w-80"><Input label="Team name" placeholder="e.g. Marketing" defaultValue="Growth team" /></div>
);

export const HelperText = () => (
  <div className="w-80"><Input label="Slack channel" placeholder="#team-growth" helperText="Agents on this team post here." /></div>
);

export const Error = () => (
  <div className="w-80"><Input label="API key" defaultValue="sk-12" error="That key is too short." /></div>
);

export const Disabled = () => (
  <div className="w-80"><Input label="Machine" defaultValue="MacBook Pro" disabled /></div>
);
