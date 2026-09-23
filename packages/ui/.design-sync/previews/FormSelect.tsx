import React from 'react';
import { FormSelect } from '@crewly/ui';

export const Default = () => (
  <div className="w-72">
    <FormSelect defaultValue="weekly">
      <option value="daily">Every day</option>
      <option value="weekly">Every week</option>
      <option value="monthly">Every month</option>
    </FormSelect>
  </div>
);
export const Error = () => (
  <div className="w-72">
    <FormSelect defaultValue="" error><option value="">Pick a project</option></FormSelect>
  </div>
);
