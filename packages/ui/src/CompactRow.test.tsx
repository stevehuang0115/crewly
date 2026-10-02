import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompactRow } from './CompactRow';

describe('CompactRow', () => {
  it('renders the primary line, meta line, leading and trailing', () => {
    render(<CompactRow primary="Ship the pricing page?" meta="Ella · Growth · 2h ago" leading={<span>L</span>} trailing={<span>T</span>} />);
    expect(screen.getByText('Ship the pricing page?')).toBeInTheDocument();
    expect(screen.getByText('Ella · Growth · 2h ago')).toBeInTheDocument();
    expect(screen.getByText('L')).toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
    expect(screen.queryByTestId('compact-row-actions')).not.toBeInTheDocument();
  });

  it('shows up to two actions and puts the rest behind ⋯', () => {
    const remind = vi.fn();
    render(
      <CompactRow
        primary="Decision"
        actions={[<button key="y" type="button">Yes</button>, <button key="n" type="button">No</button>]}
        overflow={[{ label: 'Remind me tomorrow', onClick: remind }, { label: 'Skip', onClick: () => {} }]}
        overflowLabel="More answers"
      />,
    );
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
    expect(screen.queryByText('Remind me tomorrow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More answers' }));
    fireEvent.click(screen.getByText('Remind me tomorrow'));
    expect(remind).toHaveBeenCalled();
  });

  it('makes the text area a button when clickable, separate from the actions', () => {
    const open = vi.fn();
    const yes = vi.fn();
    render(<CompactRow primary="CE-81 Pricing page" onClick={open} actions={[<button key="y" type="button" onClick={yes}>Yes</button>]} selected />);
    fireEvent.click(screen.getByRole('button', { name: /CE-81 Pricing page/ }));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(yes).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('compact-row')).toHaveAttribute('aria-current', 'true');
  });

  it('passes an overflow footer note and menu classes into the ⋯ menu', () => {
    render(<CompactRow primary="Ship it?" overflow={[{ label: 'Skip', onClick: () => {} }]} overflowFooter="If no answer by Fri, Ann waits." overflowMenuClassName="w-60" />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByText('If no answer by Fri, Ann waits.')).toBeInTheDocument();
    expect(screen.getByRole('menu').className).toContain('w-60');
  });
});
