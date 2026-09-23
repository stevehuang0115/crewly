import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('renders the trigger and a hidden tooltip revealed on hover', () => {
    render(<Tooltip content="Restart agent"><button>R</button></Tooltip>);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Restart agent');
    expect(tip).toHaveClass('opacity-0', 'group-hover:opacity-100');
  });

  it('can be forced open and placed on a side', () => {
    render(<Tooltip content="Hi" side="bottom" open><span>x</span></Tooltip>);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveClass('opacity-100', 'top-full');
  });
});
