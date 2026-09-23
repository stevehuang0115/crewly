import React from 'react';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell, StatusBadge } from '@crewly/ui';

const rows = [
  { name: 'Ella', team: 'Personal assistant', status: 'running' as const, runtime: 'Claude Code' },
  { name: 'Atlas', team: 'Think tank', status: 'paused' as const, runtime: 'Codex' },
  { name: 'Leo', team: 'Growth', status: 'error' as const, runtime: 'Gemini CLI' },
];

export const Agents = () => (
  <div className="w-full">
    <Table>
      <TableHead>
        <TableRow><TableHeader>Agent</TableHeader><TableHeader>Team</TableHeader><TableHeader>Runtime</TableHeader><TableHeader>Status</TableHeader></TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name} interactive>
            <TableCell className="font-semibold">{r.name}</TableCell>
            <TableCell className="text-text-secondary-dark">{r.team}</TableCell>
            <TableCell>{r.runtime}</TableCell>
            <TableCell><StatusBadge status={r.status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);
