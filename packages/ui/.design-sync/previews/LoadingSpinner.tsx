import React from 'react';
import { LoadingSpinner } from '@crewly/ui';

export const Sizes = () => (
  <div className="flex items-end gap-6">
    <LoadingSpinner size="xs" />
    <LoadingSpinner size="sm" />
    <LoadingSpinner size="md" />
    <LoadingSpinner size="lg" />
    <LoadingSpinner size="xl" />
  </div>
);

export const WithText = () => <LoadingSpinner size="md" text="Loading teams…" />;
