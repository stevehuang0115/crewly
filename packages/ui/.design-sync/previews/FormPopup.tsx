import React from 'react';
import { FormPopup, FormGroup, FormLabel, FormInput } from '@crewly/ui';

export const AddMember = () => (
  <div className="h-[460px]">
  <FormPopup isOpen onClose={() => {}} title="Add member" submitText="Add" onSubmit={(e) => e.preventDefault()}>
    <FormGroup>
      <FormLabel htmlFor="m" required>Name</FormLabel>
      <FormInput id="m" defaultValue="Nova" />
    </FormGroup>
  </FormPopup>
  </div>
);
