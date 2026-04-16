/**
 * TrustChipsRow Tests
 *
 * @module components/PortalOnboarding/TrustChipsRow.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TrustChipsRow } from './TrustChipsRow';

describe('TrustChipsRow', () => {
  const chips = [
    { label: 'Same-domain crawl only' },
    { label: 'Editable before save' },
    { label: 'Usually 20–30 sec' },
  ];

  it('renders all chips', () => {
    render(<TrustChipsRow chips={chips} />);
    const chipEls = screen.getAllByTestId('trust-chip');
    expect(chipEls).toHaveLength(3);
  });

  it('renders chip labels', () => {
    render(<TrustChipsRow chips={chips} />);
    expect(screen.getByText('Same-domain crawl only')).toBeInTheDocument();
    expect(screen.getByText('Editable before save')).toBeInTheDocument();
  });

  it('renders chip with icon', () => {
    const chipsWithIcon = [{ label: 'Secure', icon: <span data-testid="chip-icon">🔒</span> }];
    render(<TrustChipsRow chips={chipsWithIcon} />);
    expect(screen.getByTestId('chip-icon')).toBeInTheDocument();
  });

  it('renders nothing for empty chips', () => {
    const { container } = render(<TrustChipsRow chips={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('applies center alignment by default', () => {
    render(<TrustChipsRow chips={chips} />);
    expect(screen.getByTestId('trust-chips-row')).toHaveClass('justify-center');
  });

  it('applies left alignment when specified', () => {
    render(<TrustChipsRow chips={chips} align="left" />);
    expect(screen.getByTestId('trust-chips-row')).toHaveClass('justify-start');
  });
});
