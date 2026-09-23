import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    render(<Drawer isOpen={false} onClose={() => {}}>x</Drawer>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows title, content and footer, and closes via button, backdrop and Escape', () => {
    const onClose = vi.fn();
    render(<Drawer isOpen onClose={onClose} title="Ella" footer={<button>Save</button>}>Details</Drawer>);
    expect(screen.getByRole('heading', { name: 'Ella' })).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
