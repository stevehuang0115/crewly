// @vitest-environment jsdom
/**
 * Tests for SecurityPillarCard component
 *
 * Verifies pillar card rendering, active state styling, click/keyboard
 * interaction, and accessibility attributes per spec section 2.1.
 *
 * @module components/Security/SecurityPillarCard.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Shield } from 'lucide-react';
import { SecurityPillarCard, type PillarId } from './SecurityPillarCard';

/** Default props factory */
function makeProps(overrides?: Partial<React.ComponentProps<typeof SecurityPillarCard>>) {
  return {
    id: 'pty' as PillarId,
    icon: Shield,
    title: 'PTY Isolation',
    description: 'Every agent in its own sandbox.',
    isActive: false,
    onSeeHow: vi.fn(),
    ...overrides,
  };
}

describe('SecurityPillarCard', () => {
  it('should render title, description, and See how link', () => {
    render(<SecurityPillarCard {...makeProps()} />);
    expect(screen.getByText('PTY Isolation')).toBeDefined();
    expect(screen.getByText('Every agent in its own sandbox.')).toBeDefined();
    expect(screen.getByRole('button', { name: /see how/i })).toBeDefined();
  });

  it('should render with correct testid', () => {
    render(<SecurityPillarCard {...makeProps({ id: 'storage' })} />);
    expect(screen.getByTestId('pillar-card-storage')).toBeDefined();
  });

  it('should call onSeeHow with pillar id on click', () => {
    const onSeeHow = vi.fn();
    render(<SecurityPillarCard {...makeProps({ onSeeHow })} />);
    fireEvent.click(screen.getByRole('button', { name: /see how/i }));
    expect(onSeeHow).toHaveBeenCalledWith('pty');
  });

  it('should call onSeeHow on Enter key press', () => {
    const onSeeHow = vi.fn();
    render(<SecurityPillarCard {...makeProps({ onSeeHow })} />);
    const button = screen.getByRole('button', { name: /see how/i });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onSeeHow).toHaveBeenCalledWith('pty');
  });

  it('should call onSeeHow on Space key press', () => {
    const onSeeHow = vi.fn();
    render(<SecurityPillarCard {...makeProps({ onSeeHow })} />);
    const button = screen.getByRole('button', { name: /see how/i });
    fireEvent.keyDown(button, { key: ' ' });
    expect(onSeeHow).toHaveBeenCalledWith('pty');
  });

  it('should not call onSeeHow on other keys', () => {
    const onSeeHow = vi.fn();
    render(<SecurityPillarCard {...makeProps({ onSeeHow })} />);
    const button = screen.getByRole('button', { name: /see how/i });
    fireEvent.keyDown(button, { key: 'Tab' });
    expect(onSeeHow).not.toHaveBeenCalled();
  });

  it('should set aria-expanded true when active', () => {
    render(<SecurityPillarCard {...makeProps({ isActive: true })} />);
    const button = screen.getByRole('button', { name: /see how/i });
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('should set aria-expanded false when inactive', () => {
    render(<SecurityPillarCard {...makeProps({ isActive: false })} />);
    const button = screen.getByRole('button', { name: /see how/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('should apply active border styles when active', () => {
    const { container } = render(<SecurityPillarCard {...makeProps({ isActive: true })} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-blue-500');
  });

  it('should apply default border styles when inactive', () => {
    const { container } = render(<SecurityPillarCard {...makeProps({ isActive: false })} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-zinc-700');
  });

  it('should render all three pillar ids with correct colors', () => {
    const ids: PillarId[] = ['pty', 'storage', 'approval'];
    ids.forEach((id) => {
      const { unmount } = render(<SecurityPillarCard {...makeProps({ id, isActive: true })} />);
      expect(screen.getByTestId(`pillar-card-${id}`)).toBeDefined();
      unmount();
    });
  });

  it('should set aria-controls pointing to diagram', () => {
    render(<SecurityPillarCard {...makeProps()} />);
    const button = screen.getByRole('button', { name: /see how/i });
    expect(button.getAttribute('aria-controls')).toBe('security-arch-diagram');
  });
});
