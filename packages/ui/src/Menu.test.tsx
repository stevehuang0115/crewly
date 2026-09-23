import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Menu } from './Menu';

describe('Menu', () => {
  it('opens from its trigger and runs the picked item, then closes', () => {
    const rename = vi.fn();
    render(<Menu trigger={<button>Actions</button>} items={[{ label: 'Rename', onSelect: rename }, { label: 'Delete', onSelect: () => {}, danger: true }]} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(rename).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape and outside click', () => {
    render(<Menu defaultOpen trigger={<button>A</button>} items={[{ label: 'One', onSelect: () => {} }]} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows danger items in red and keeps the trigger own onClick', () => {
    const own = vi.fn();
    render(<Menu trigger={<button onClick={own}>A</button>} items={[{ label: 'Delete', onSelect: () => {}, danger: true }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(own).toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-red-400');
  });
});
