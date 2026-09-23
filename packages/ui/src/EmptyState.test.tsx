import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Users } from 'lucide-react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('shows the title, description and action', () => {
    render(<EmptyState icon={Users} title="No teams yet" description="Create one to start." action={<button>New team</button>} />);
    expect(screen.getByRole('heading', { name: 'No teams yet' })).toBeInTheDocument();
    expect(screen.getByText('Create one to start.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New team' })).toBeInTheDocument();
  });

  it('uses tighter spacing when compact', () => {
    const { container } = render(<EmptyState title="Nothing" compact />);
    expect(container.firstChild).toHaveClass('py-6');
  });
});
