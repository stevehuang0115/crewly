/**
 * Tests for "Your crew right now".
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CrewNowSection, idleLine } from './CrewNowSection';

const working = Array.from({ length: 7 }, (_, i) => ({ session: `s-${i}`, name: `Agent ${i}`, team: 'CE', doing: i === 0 ? null : `task ${i}` }));

describe('CrewNowSection', () => {
  it('lists working agents linking to their chat, five then "Show all", and idle on one line', () => {
    render(<MemoryRouter><CrewNowSection crew={{ working, idle: ['Sam', 'Max'] }} /></MemoryRouter>);
    expect(screen.getByTestId('crew-s-0')).toHaveTextContent('Agent 0 · CE — working');
    expect(screen.getByTestId('crew-s-1')).toHaveAttribute('href', '/team-chat?agent=s-1');
    expect(screen.queryByTestId('crew-s-5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getByTestId('crew-s-6')).toBeInTheDocument();
    expect(screen.getByTestId('crew-idle')).toHaveTextContent('2 idle — Sam, Max');
    expect(screen.getByRole('link', { name: 'All agents' })).toHaveAttribute('href', '/teams');
  });

  it('says so when nobody is working', () => {
    render(<MemoryRouter><CrewNowSection crew={{ working: [], idle: [] }} /></MemoryRouter>);
    expect(screen.getByText('Nobody is working right now.')).toBeInTheDocument();
    expect(screen.queryByTestId('crew-idle')).not.toBeInTheDocument();
  });

  it('idleLine caps the names', () => {
    expect(idleLine([])).toBeNull();
    expect(idleLine(Array.from({ length: 10 }, (_, i) => `N${i}`))).toBe('10 idle — N0, N1, N2, N3, N4, N5, N6, N7 and 2 more');
  });
});
