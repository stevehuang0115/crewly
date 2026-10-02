import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders title, subtitle, actions and tabs', () => {
    render(
      <PageHeader
        title="Tickets"
        subtitle="Everything your crew is working on"
        actions={<button type="button">New ticket</button>}
        tabs={<div role="tablist" aria-label="views" />}
        eyebrow={<a href="/tickets">Back</a>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Tickets' })).toBeInTheDocument();
    expect(screen.getByText('Everything your crew is working on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New ticket' })).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back' })).toBeInTheDocument();
  });

  it('omits empty slots', () => {
    render(<PageHeader title="Usage" />);
    const header = screen.getByTestId('page-header');
    expect(header.querySelectorAll('p')).toHaveLength(0);
    expect(header.textContent).toBe('Usage');
  });
});
