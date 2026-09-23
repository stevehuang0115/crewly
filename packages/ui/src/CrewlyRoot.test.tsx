import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CrewlyRoot } from './CrewlyRoot';

describe('CrewlyRoot', () => {
  it('puts its children on the Crewly surface', () => {
    render(<CrewlyRoot data-testid="root"><span>hi</span></CrewlyRoot>);
    const root = screen.getByTestId('root');
    expect(root).toHaveClass('bg-background-dark', 'text-text-primary-dark', 'font-sans');
    expect(root).toHaveTextContent('hi');
  });

  it('keeps a caller className alongside the surface classes', () => {
    render(<CrewlyRoot data-testid="root" className="p-6">x</CrewlyRoot>);
    expect(screen.getByTestId('root')).toHaveClass('p-6', 'bg-background-dark');
  });
});
