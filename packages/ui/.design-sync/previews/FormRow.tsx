import React from 'react';
import { FormRow, FormGroup, FormLabel, FormInput } from '@crewly/ui';

export const TwoColumns = () => (
  <div className="w-[520px]">
    <FormRow>
      <FormGroup><FormLabel htmlFor="f">First name</FormLabel><FormInput id="f" defaultValue="Ada" /></FormGroup>
      <FormGroup><FormLabel htmlFor="l">Last name</FormLabel><FormInput id="l" defaultValue="Lovelace" /></FormGroup>
    </FormRow>
  </div>
);
