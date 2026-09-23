import React from 'react';
import { Button } from '@crewly/ui';
import { Plus, Play, Trash2, ArrowRight } from 'lucide-react';

export const Primary = () => <Button icon={Plus}>New team</Button>;

export const Variants = () => (
  <div className="flex flex-wrap gap-3">
    <Button variant="primary">Start agent</Button>
    <Button variant="secondary">Edit roles</Button>
    <Button variant="outline">View logs</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="success" icon={Play}>Resume</Button>
    <Button variant="warning">Pause all</Button>
    <Button variant="danger" icon={Trash2}>Delete team</Button>
    <Button variant="danger-ghost">Remove</Button>
  </div>
);

export const Sizes = () => (
  <div className="flex items-center gap-3">
    <Button>Default</Button>
    <Button size="sm">Small</Button>
    <Button size="icon" icon={Plus} aria-label="Add" />
  </div>
);

export const States = () => (
  <div className="flex items-center gap-3">
    <Button loading>Deploying</Button>
    <Button disabled>Disabled</Button>
    <Button icon={ArrowRight} iconPosition="right">Continue</Button>
  </div>
);

export const FullWidth = () => (
  <div className="w-80">
    <Button fullWidth>Connect to Crewly Cloud</Button>
  </div>
);
