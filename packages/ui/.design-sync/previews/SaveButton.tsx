import React from 'react';
import { SaveButton } from '@crewly/ui';

export const Idle = () => <SaveButton onClick={() => {}}>Save changes</SaveButton>;

export const Statuses = () => (
  <div className="flex items-center gap-3">
    <SaveButton onClick={() => {}} status="idle" />
    <SaveButton onClick={() => {}} status="saving" />
    <SaveButton onClick={() => {}} status="saved" />
    <SaveButton onClick={() => {}} status="error" />
  </div>
);

export const Disabled = () => <SaveButton onClick={() => {}} disabled>Save</SaveButton>;
