import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('is a checkbox switch that the label toggles', () => {
    const onChange = vi.fn();
    render(<Toggle label="Remote desktop" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Remote desktop' });
    expect(box).toHaveClass('peer', 'sr-only');
    fireEvent.click(screen.getByText('Remote desktop'));
    expect(onChange).toHaveBeenCalled();
  });

  it('colors the track by variant and size', () => {
    const { container } = render(<Toggle size="lg" variant="success" defaultChecked />);
    const slider = container.querySelector('.toggle-slider')!;
    expect(slider.className).toContain('peer-checked:bg-emerald-500');
    expect(slider.className).toContain('w-12');
  });

  it('shows the description and dims when disabled', () => {
    const { container } = render(<Toggle label="Sync" description="Every hour" disabled />);
    expect(screen.getByText('Every hour')).toHaveClass('toggle-description');
    expect(container.querySelector('.toggle-wrapper')).toHaveClass('opacity-50');
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});
