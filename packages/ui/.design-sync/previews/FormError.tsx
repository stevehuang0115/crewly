import React from 'react';
import { FormError, FormGroup, FormLabel, FormInput } from '@crewly/ui';

export const UnderAField = () => (
  <div className="w-80">
    <FormGroup>
      <FormLabel htmlFor="k">API key</FormLabel>
      <FormInput id="k" defaultValue="sk-12" error />
      <FormError>That key is too short.</FormError>
    </FormGroup>
  </div>
);
