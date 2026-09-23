import React from 'react';
import { CrewlyRoot, Card, Button, Badge } from '@crewly/ui';

export const Page = () => (
  <CrewlyRoot className="p-6 w-[520px] rounded-2xl">
    <h2 className="text-lg font-semibold mb-1">Teams</h2>
    <p className="text-sm text-text-secondary-dark mb-4">Everything below sits on the Crewly surface.</p>
    <Card>
      <div className="flex items-center justify-between">
        <span className="font-semibold">Growth</span>
        <Badge variant="success">Running</Badge>
      </div>
      <div className="mt-3"><Button size="sm">Open</Button></div>
    </Card>
  </CrewlyRoot>
);
