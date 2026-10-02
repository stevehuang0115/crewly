import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Trash2 } from 'lucide-react';
import { OverflowMenu } from './OverflowMenu';

describe('OverflowMenu', () => {
  it('keeps the original API: "More options" trigger, items run and close the menu', () => {
    const onEdit = vi.fn();
    render(<OverflowMenu items={[{ label: 'Edit', onClick: onEdit }, { label: 'Delete', onClick: () => {}, danger: true }]} />);
    const trigger = screen.getByRole('button', { name: 'More options' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Delete').className).toContain('text-red-300');
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('supports a custom label, icons, separators and disabled items', () => {
    const onDel = vi.fn();
    render(
      <OverflowMenu
        label="More actions for CE-81"
        defaultOpen
        items={[
          { label: 'Remind me tomorrow', onClick: () => {} },
          { label: 'Delete', onClick: onDel, icon: Trash2, separator: true, disabled: true },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'More actions for CE-81' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('separator')).toBeInTheDocument();
    const del = screen.getByRole('menuitem', { name: 'Delete' });
    expect(del).toBeDisabled();
    expect(del.querySelector('svg')).not.toBeNull();
  });

  it('closes on Escape and on outside click', () => {
    render(<OverflowMenu defaultOpen items={[{ label: 'A', onClick: () => {} }]} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders an optional footer note under the items', () => {
    render(<OverflowMenu defaultOpen footer="If no answer by Fri, Atlas waits." items={[{ label: 'Skip', onClick: () => {} }]} />);
    expect(screen.getByTestId('overflow-menu-footer')).toHaveTextContent('If no answer by Fri, Atlas waits.');
  });
});
