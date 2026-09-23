import React from 'react';
import { Toggle } from '@crewly/ui';

export const WithDescription = () => (
  <div className="w-96">
    <Toggle label="Remote desktop" description="Let the portal see and control this Mac." defaultChecked />
  </div>
);

export const Sizes = () => (
  <div className="flex flex-col items-start gap-3">
    <Toggle size="sm" label="Small" defaultChecked />
    <Toggle size="md" label="Medium" defaultChecked />
    <Toggle size="lg" label="Large" defaultChecked />
  </div>
);

export const Variants = () => (
  <div className="flex flex-col items-start gap-3">
    <Toggle variant="default" label="Default" defaultChecked />
    <Toggle variant="success" label="Success" defaultChecked />
    <Toggle variant="warning" label="Warning" defaultChecked />
    <Toggle variant="danger" label="Danger" defaultChecked />
  </div>
);

export const States = () => (
  <div className="flex flex-col items-start gap-3">
    <Toggle label="Off" />
    <Toggle label="Disabled" disabled />
    <Toggle label="Label on the left" labelPosition="left" defaultChecked />
  </div>
);
