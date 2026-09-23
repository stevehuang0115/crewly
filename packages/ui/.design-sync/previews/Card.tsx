import React from 'react';
import { Card, Badge, Button } from '@crewly/ui';

export const Default = () => (
  <Card className="w-80">
    <div className="flex items-center justify-between mb-2">
      <h3 className="font-semibold">Marketing team</h3>
      <Badge variant="success">Running</Badge>
    </div>
    <p className="text-sm text-text-secondary-dark mb-4">3 agents · 5 open tasks · last active 2 min ago</p>
    <Button size="sm" variant="secondary">Open team</Button>
  </Card>
);

export const Variants = () => (
  <div className="grid grid-cols-3 gap-3 w-[640px]">
    <Card variant="default"><p className="text-sm">Default</p></Card>
    <Card variant="outlined"><p className="text-sm">Outlined</p></Card>
    <Card variant="elevated"><p className="text-sm">Elevated</p></Card>
  </div>
);

export const Padding = () => (
  <div className="flex items-start gap-3">
    <Card padding="sm"><p className="text-sm">sm</p></Card>
    <Card padding="md"><p className="text-sm">md</p></Card>
    <Card padding="lg"><p className="text-sm">lg</p></Card>
  </div>
);

export const Interactive = () => (
  <Card interactive className="w-80">
    <h3 className="font-semibold mb-1">Ella</h3>
    <p className="text-sm text-text-secondary-dark">Team lead · Personal assistant team</p>
  </Card>
);
