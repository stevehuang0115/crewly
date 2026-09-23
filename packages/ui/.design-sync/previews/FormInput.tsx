import React from 'react';
import { FormInput } from '@crewly/ui';

export const States = () => (
  <div className="w-80 space-y-3">
    <FormInput placeholder="Search agents" />
    <FormInput defaultValue="Growth team" />
    <FormInput defaultValue="not-an-email" error />
    <FormInput defaultValue="Read only" disabled />
  </div>
);
