import React from 'react';
import { FormGroup, FormLabel, FormInput, FormHelp } from '@crewly/ui';

export const LabelInputHelp = () => (
  <div className="w-80">
    <FormGroup>
      <FormLabel htmlFor="dn">Display name</FormLabel>
      <FormInput id="dn" defaultValue="Ella" />
      <FormHelp>Shown in Slack and the portal.</FormHelp>
    </FormGroup>
  </div>
);
