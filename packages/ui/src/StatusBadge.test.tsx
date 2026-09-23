import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders with correct status text', () => {
    render(<StatusBadge status="active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders with custom children', () => {
    render(<StatusBadge status="active">Running Now</StatusBadge>);
    expect(screen.getByText('Running Now')).toBeInTheDocument();
  });

  it('applies correct styling classes', () => {
    render(<StatusBadge status="stopped" />);
    const badge = screen.getByText('Stopped');
    expect(badge).toHaveClass('bg-red-500/10', 'text-red-400');
  });
});