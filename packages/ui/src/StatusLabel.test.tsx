import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusLabel, statusTone } from './StatusLabel';

describe('StatusLabel', () => {
  it('shows the word next to a dot, with the tone on the element', () => {
    render(<StatusLabel tone="attention">Needs you</StatusLabel>);
    const label = screen.getByTestId('status-label');
    expect(label).toHaveTextContent('Needs you');
    expect(label).toHaveAttribute('data-tone', 'attention');
    expect(label.className).toContain('text-attention');
    expect(label.querySelector('[aria-hidden="true"]')?.className).toContain('bg-attention');
  });

  it.each([
    ['success', 'bg-success'],
    ['danger', 'bg-danger'],
    ['neutral', 'bg-muted-dot'],
    ['primary', 'bg-primary'],
  ] as const)('uses the %s token for the dot', (tone, cls) => {
    render(<StatusLabel tone={tone}>x</StatusLabel>);
    expect(screen.getByTestId('status-label').querySelector('span')?.className).toContain(cls);
  });

  it('pulses only when asked', () => {
    const { rerender } = render(<StatusLabel tone="primary">Running</StatusLabel>);
    expect(screen.getByTestId('status-label').innerHTML).not.toContain('animate-pulse');
    rerender(<StatusLabel tone="primary" pulse>Running</StatusLabel>);
    expect(screen.getByTestId('status-label').innerHTML).toContain('animate-pulse');
  });
});

describe('statusTone', () => {
  it('maps common status words', () => {
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('blocked')).toBe('attention');
    expect(statusTone('Needs you')).toBe('attention');
    expect(statusTone('in_progress')).toBe('primary');
    expect(statusTone('in-progress')).toBe('primary');
    expect(statusTone('completed')).toBe('success');
    expect(statusTone('queued')).toBe('neutral');
    expect(statusTone(undefined)).toBe('neutral');
  });
});
