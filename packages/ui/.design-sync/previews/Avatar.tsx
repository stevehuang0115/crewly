import React from 'react';
import { Avatar } from '@crewly/ui';

export const Sizes = () => (
  <div className="flex items-end gap-3">
    <Avatar name="Ella" size="xs" />
    <Avatar name="Ella" size="sm" />
    <Avatar name="Ella" size="md" />
    <Avatar name="Ella" size="lg" />
    <Avatar name="Ella" size="xl" />
  </div>
);

export const Initials = () => (
  <div className="flex gap-3">
    <Avatar name="Atlas" size="lg" />
    <Avatar name="Leo Park" size="lg" />
    <Avatar fallbackName="Orchestrator" size="lg" />
    <Avatar name="Ella" size="lg" showRing />
  </div>
);
