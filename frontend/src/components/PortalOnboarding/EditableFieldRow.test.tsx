/**
 * Tests for EditableFieldRow component.
 *
 * @module components/PortalOnboarding/EditableFieldRow.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditableFieldRow } from './EditableFieldRow';
import type { PrefillField } from '../../types/onboarding.types';

const mockField: PrefillField<string> = {
  value: 'Acme Corp',
  sourceUrls: ['https://acme.com/'],
  confidence: 'high',
  extractionMethod: 'rule',
  needsReview: false,
  sourceSnippet: 'Acme Corp is a leading company',
};

describe('EditableFieldRow', () => {
  it('renders label and value', () => {
    render(
      <EditableFieldRow
        label="Business Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByText('Business Name')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('shows "Not detected" when field is null', () => {
    render(
      <EditableFieldRow
        label="Location"
        field={null}
        required={false}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByText('Not detected')).toBeInTheDocument();
  });

  it('shows required label when field is null and required', () => {
    render(
      <EditableFieldRow
        label="Name"
        field={null}
        required={true}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('shows confidence pill', () => {
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('shows Manual confidence when edited', () => {
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
        isEdited={true}
      />
    );
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('enters edit mode on edit button click', () => {
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('field-edit-btn'));
    expect(screen.getByTestId('field-edit-input')).toBeInTheDocument();
  });

  it('calls onEdit with new value on save', () => {
    const onEdit = vi.fn();
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByTestId('field-edit-btn'));
    const input = screen.getByTestId('field-edit-input');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByTestId('field-save-btn'));
    expect(onEdit).toHaveBeenCalledWith('New Name');
  });

  it('saves on Enter key', () => {
    const onEdit = vi.fn();
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByTestId('field-edit-btn'));
    const input = screen.getByTestId('field-edit-input');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledWith('New Name');
  });

  it('cancels on Escape key', () => {
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('field-edit-btn'));
    const input = screen.getByTestId('field-edit-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('field-edit-input')).not.toBeInTheDocument();
  });

  it('shows reset button when edited', () => {
    const onReset = vi.fn();
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
        onReset={onReset}
        isEdited={true}
      />
    );
    expect(screen.getByTestId('field-reset-btn')).toBeInTheDocument();
  });

  it('calls onReset when reset button clicked', () => {
    const onReset = vi.fn();
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
        onReset={onReset}
        isEdited={true}
      />
    );
    fireEvent.click(screen.getByTestId('field-reset-btn'));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('displays array values joined by " / "', () => {
    const arrayField: PrefillField<string[]> = {
      ...mockField,
      value: ['Red', 'Blue', 'Green'],
    };
    render(
      <EditableFieldRow
        label="Colors"
        field={arrayField}
        required={false}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByText('Red / Blue / Green')).toBeInTheDocument();
  });

  it('shows source button when field has source URLs', () => {
    render(
      <EditableFieldRow
        label="Name"
        field={mockField}
        required={false}
        onEdit={vi.fn()}
      />
    );
    expect(screen.getByTestId('field-source-btn')).toBeInTheDocument();
  });
});
