import React from 'react';
import { FormSection, FormGroup, FormLabel, FormInput } from '@crewly/ui';

export const WithDescription = () => (
  <div className="w-[480px]">
    <FormSection title="Slack" description="Where this team talks to you.">
      <FormGroup>
        <FormLabel htmlFor="ch">Channel</FormLabel>
        <FormInput id="ch" defaultValue="#team-growth" />
      </FormGroup>
    </FormSection>
  </div>
);
