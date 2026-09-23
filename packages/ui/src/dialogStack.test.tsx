import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDialogLayer, _openDialogCount } from './dialogStack';

const Layer: React.FC<{ open: boolean; onEscape: () => void }> = ({ open, onEscape }) => {
  useDialogLayer(open, onEscape);
  return null;
};

describe('useDialogLayer', () => {
  it('lets only the topmost dialog answer Escape', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(<><Layer open onEscape={outer} /><Layer open onEscape={inner} /></>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    rerender(<><Layer open onEscape={outer} /><Layer open={false} onEscape={inner} /></>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('keeps the page locked until the last dialog closes, then restores it', () => {
    document.body.style.overflow = 'auto';
    const { rerender, unmount } = render(<><Layer open onEscape={() => {}} /><Layer open onEscape={() => {}} /></>);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<><Layer open onEscape={() => {}} /><Layer open={false} onEscape={() => {}} /></>);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('auto');
    expect(_openDialogCount()).toBe(0);
  });
});
