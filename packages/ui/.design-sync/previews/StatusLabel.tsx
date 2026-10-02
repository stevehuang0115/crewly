import React from 'react';
import { StatusLabel } from '@crewly/ui';

export const Tones = () => (
  <div className="flex flex-wrap items-center gap-6">
    <StatusLabel tone="success">Done</StatusLabel>
    <StatusLabel tone="attention">Needs you</StatusLabel>
    <StatusLabel tone="danger">Failed</StatusLabel>
    <StatusLabel tone="neutral">Queued</StatusLabel>
    <StatusLabel tone="primary" pulse>Running</StatusLabel>
  </div>
);
