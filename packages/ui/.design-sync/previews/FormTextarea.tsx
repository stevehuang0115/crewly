import React from 'react';
import { FormTextarea } from '@crewly/ui';

export const Default = () => (
  <div className="w-96"><FormTextarea rows={4} defaultValue={'You are the team lead.\nBreak the goal into tasks and assign them.'} /></div>
);
export const Error = () => (
  <div className="w-96"><FormTextarea rows={2} defaultValue="" placeholder="A goal is required" error /></div>
);
