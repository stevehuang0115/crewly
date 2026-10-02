import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollapsibleSection } from './CollapsibleSection';

describe('CollapsibleSection', () => {
  it('starts collapsed (content kept mounted but hidden) and toggles', () => {
    render(<CollapsibleSection title="Advanced" summary="Probe interval"><input aria-label="Probe" /></CollapsibleSection>);
    const toggle = screen.getByRole('button', { name: /Advanced/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Probe interval')).toBeInTheDocument();
    expect(screen.getByLabelText('Probe', { selector: 'input' }).closest('[hidden]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Probe').closest('[hidden]')).toBeNull();
    expect(screen.queryByText('Probe interval')).not.toBeInTheDocument();
  });

  it('can unmount closed content and be controlled', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <CollapsibleSection title="More" open={false} onOpenChange={onOpenChange} unmountWhenClosed>
        <p>Inside</p>
      </CollapsibleSection>,
    );
    expect(screen.queryByText('Inside')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText('Inside')).not.toBeInTheDocument();
    rerender(
      <CollapsibleSection title="More" open onOpenChange={onOpenChange} unmountWhenClosed>
        <p>Inside</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('Inside')).toBeVisible();
  });
});
