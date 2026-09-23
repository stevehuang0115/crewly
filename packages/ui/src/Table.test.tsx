import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './Table';

describe('Table', () => {
  it('renders a styled table with header and rows', () => {
    render(
      <Table>
        <TableHead><TableRow><TableHeader>Agent</TableHeader></TableRow></TableHead>
        <TableBody><TableRow interactive><TableCell>Ella</TableCell></TableRow></TableBody>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Agent' })).toHaveClass('uppercase');
    expect(screen.getByRole('cell', { name: 'Ella' }).closest('tr')).toHaveClass('cursor-pointer');
  });
});
