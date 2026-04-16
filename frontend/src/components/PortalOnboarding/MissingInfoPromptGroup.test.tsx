/**
 * MissingInfoPromptGroup Tests
 *
 * @module components/PortalOnboarding/MissingInfoPromptGroup.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MissingInfoPromptGroup, type MissingPrompt } from './MissingInfoPromptGroup';

describe('MissingInfoPromptGroup', () => {
  const mockOnChange = vi.fn();

  const textPrompt: MissingPrompt = {
    key: 'targetCustomer',
    label: 'Target Customer',
    type: 'text',
    required: true,
  };

  const selectPrompt: MissingPrompt = {
    key: 'channel',
    label: 'Main Channel',
    type: 'select',
    options: ['Slack', 'Discord', 'Email'],
  };

  const chipPrompt: MissingPrompt = {
    key: 'tone',
    label: 'Tone',
    type: 'chips',
    options: ['Professional', 'Casual', 'Friendly'],
  };

  it('renders nothing when no prompts', () => {
    const { container } = render(
      <MissingInfoPromptGroup prompts={[]} values={{}} onChange={mockOnChange} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders text input prompt', () => {
    render(
      <MissingInfoPromptGroup prompts={[textPrompt]} values={{}} onChange={mockOnChange} />
    );
    expect(screen.getByTestId('prompt-targetCustomer')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-input-targetCustomer')).toBeInTheDocument();
  });

  it('calls onChange on text input', () => {
    render(
      <MissingInfoPromptGroup prompts={[textPrompt]} values={{}} onChange={mockOnChange} />
    );
    fireEvent.change(screen.getByTestId('prompt-input-targetCustomer'), {
      target: { value: 'SaaS founders' },
    });
    expect(mockOnChange).toHaveBeenCalledWith('targetCustomer', 'SaaS founders');
  });

  it('renders select prompt with options', () => {
    render(
      <MissingInfoPromptGroup prompts={[selectPrompt]} values={{}} onChange={mockOnChange} />
    );
    expect(screen.getByTestId('prompt-select-channel')).toBeInTheDocument();
  });

  it('renders chip prompt with options', () => {
    render(
      <MissingInfoPromptGroup prompts={[chipPrompt]} values={{}} onChange={mockOnChange} />
    );
    expect(screen.getByTestId('prompt-chip-Professional')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-chip-Casual')).toBeInTheDocument();
  });

  it('toggles chip selection', () => {
    mockOnChange.mockClear();
    render(
      <MissingInfoPromptGroup
        prompts={[chipPrompt]}
        values={{ tone: ['Professional'] }}
        onChange={mockOnChange}
      />
    );
    // Click to deselect Professional
    fireEvent.click(screen.getByTestId('prompt-chip-Professional'));
    expect(mockOnChange).toHaveBeenCalledWith('tone', []);

    // Click to select Casual
    mockOnChange.mockClear();
    fireEvent.click(screen.getByTestId('prompt-chip-Casual'));
    expect(mockOnChange).toHaveBeenCalledWith('tone', ['Professional', 'Casual']);
  });

  it('shows required indicator', () => {
    render(
      <MissingInfoPromptGroup prompts={[textPrompt]} values={{}} onChange={mockOnChange} />
    );
    expect(screen.getByText('*')).toBeInTheDocument();
  });
});
