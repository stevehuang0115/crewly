/**
 * MessageForm tests — create/edit dialog for scheduled messages.
 *
 * @module components/ScheduledCheckins/MessageForm.test
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageForm } from './MessageForm';
import { DEFAULT_FORM_DATA, type ScheduledMessage, type ScheduledMessageFormData } from './types';

const teamOptions = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'dev-team', label: 'Dev Team' },
];

function renderForm(overrides: Partial<React.ComponentProps<typeof MessageForm>> = {}) {
  const props = {
    isOpen: true,
    editingMessage: null,
    formData: { ...DEFAULT_FORM_DATA } as ScheduledMessageFormData,
    setFormData: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    teamOptions,
    ...overrides,
  };
  render(<MessageForm {...props} />);
  return props;
}

describe('MessageForm', () => {
  it('renders nothing when closed', () => {
    renderForm({ isOpen: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the create title and team options when open', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: 'Create New Scheduled Message' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Dev Team' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Schedule/ })).toBeInTheDocument();
  });

  it('shows the edit title and update label when editing', () => {
    const editing: ScheduledMessage = {
      id: 'm1',
      name: 'Standup',
      targetTeam: 'orchestrator',
      message: 'hi',
      delayAmount: 5,
      delayUnit: 'minutes',
      isRecurring: false,
      isActive: true,
      createdAt: '',
      updatedAt: '',
    };
    renderForm({ editingMessage: editing });
    expect(screen.getByRole('heading', { name: 'Edit Scheduled Message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update Schedule/ })).toBeInTheDocument();
  });

  it('writes field edits through setFormData', () => {
    const props = renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Daily' } });
    expect(props.setFormData).toHaveBeenCalledWith(expect.objectContaining({ name: 'Daily' }));
  });

  it('switches to recurring when the Recurring card is chosen', () => {
    const props = renderForm();
    fireEvent.click(screen.getByLabelText(/Recurring/));
    expect(props.setFormData).toHaveBeenCalledWith(expect.objectContaining({ isRecurring: true }));
  });

  it('submits from the footer button and closes from Cancel', () => {
    const props = renderForm();
    fireEvent.click(screen.getByRole('button', { name: /Create Schedule/ }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
