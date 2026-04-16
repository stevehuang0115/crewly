/**
 * GuidedActionChecklist Tests
 *
 * @module components/PortalOnboarding/GuidedActionChecklist.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GuidedActionChecklist, type GuidedActionItem } from './GuidedActionChecklist';

describe('GuidedActionChecklist', () => {
  const items: GuidedActionItem[] = [
    { id: 'slack', label: 'Connect Slack', status: 'active' },
    { id: 'brief', label: 'Review brand brief', status: 'todo' },
    { id: 'workflow', label: 'Launch first workflow', status: 'todo' },
  ];

  it('renders all checklist items', () => {
    render(<GuidedActionChecklist items={items} />);
    expect(screen.getByTestId('checklist-item-slack')).toBeInTheDocument();
    expect(screen.getByTestId('checklist-item-brief')).toBeInTheDocument();
    expect(screen.getByTestId('checklist-item-workflow')).toBeInTheDocument();
  });

  it('renders numbered labels', () => {
    render(<GuidedActionChecklist items={items} />);
    expect(screen.getByText(/1\. Connect Slack/)).toBeInTheDocument();
    expect(screen.getByText(/2\. Review brand brief/)).toBeInTheDocument();
  });

  it('renders primary action button', () => {
    const onAction = vi.fn();
    render(
      <GuidedActionChecklist items={items} primaryActionLabel="Connect Slack" onPrimaryAction={onAction} />
    );
    const btn = screen.getByTestId('checklist-primary-action');
    expect(btn).toHaveTextContent('Connect Slack');
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalled();
  });

  it('renders secondary action button', () => {
    render(
      <GuidedActionChecklist
        items={items}
        secondaryActionLabel="Open workspace"
        onSecondaryAction={vi.fn()}
      />
    );
    expect(screen.getByTestId('checklist-secondary-action')).toHaveTextContent('Open workspace');
  });

  it('renders done items with checkmark style', () => {
    const doneItems: GuidedActionItem[] = [
      { id: 'slack', label: 'Connect Slack', status: 'done' },
    ];
    render(<GuidedActionChecklist items={doneItems} />);
    const item = screen.getByTestId('checklist-item-slack');
    expect(item).toHaveClass('text-emerald-400');
  });
});
