import React from 'react';
import { Badge } from '@crewly/ui';

export const Variants = () => (
  <div className="flex flex-wrap gap-2">
    <Badge>Draft</Badge>
    <Badge variant="primary">Pro</Badge>
    <Badge variant="success">Running</Badge>
    <Badge variant="warning">Needs approval</Badge>
    <Badge variant="error">Failed</Badge>
    <Badge variant="info">New</Badge>
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-2">
    <Badge size="sm" variant="primary">Small</Badge>
    <Badge size="md" variant="primary">Medium</Badge>
  </div>
);
