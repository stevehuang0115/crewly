/**
 * Tests for ApiKeyForm: submit clears the field.
 *
 * @module components/Harness/ApiKeyForm.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyForm } from './ApiKeyForm';
import { harnessService } from '../../services/harness.service';
import { makeHarness } from '../../test/harness.fixtures';

vi.mock('../../services/harness.service', () => ({
  harnessService: { setApiKey: vi.fn() },
}));

const svc = vi.mocked(harnessService);

describe('ApiKeyForm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a password field and the Anthropic console link', () => {
    render(<ApiKeyForm harnessId="claude-code" label="使用 API Key" />);
    expect(screen.getByLabelText('使用 API Key')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: /console.anthropic.com/ })).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys',
    );
  });

  it('for Antigravity: Google AI Studio link, an AIza placeholder and the API-key-only note', () => {
    render(<ApiKeyForm harnessId="antigravity-cli" label="使用 Gemini API Key" />);
    expect(screen.getByLabelText('使用 Gemini API Key')).toHaveAttribute('placeholder', 'AIza…');
    expect(screen.getByRole('link', { name: /Google AI Studio/ })).toHaveAttribute('href', 'https://aistudio.google.com/apikey');
    expect(screen.getByTestId('api-key-note')).toHaveTextContent('never your Google account login');
  });

  it('shows no note for harnesses without one', () => {
    render(<ApiKeyForm harnessId="codex-cli" label="使用 OpenAI API Key" />);
    expect(screen.queryByTestId('api-key-note')).not.toBeInTheDocument();
    expect(screen.getByLabelText('使用 OpenAI API Key')).toHaveAttribute('placeholder', 'sk-…');
  });

  it('clears the key on submit, saves it and reports the new status', async () => {
    let resolve: (v: ReturnType<typeof makeHarness>) => void = () => {};
    svc.setApiKey.mockImplementation(() => new Promise((r) => (resolve = r)));
    const onSaved = vi.fn();
    render(<ApiKeyForm harnessId="claude-code" label="使用 API Key" onSaved={onSaved} />);
    const input = screen.getByLabelText('使用 API Key') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '  sk-ant-secret  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    });
    // Cleared before the request resolves.
    expect(input.value).toBe('');
    expect(svc.setApiKey).toHaveBeenCalledWith('claude-code', 'sk-ant-secret');

    await act(async () => {
      resolve(makeHarness({ loginState: 'logged_in' }));
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ loginState: 'logged_in' }));
    expect(screen.getByText(/API Key 已保存/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-ant-secret/)).not.toBeInTheDocument();
  });

  it('shows an error and keeps the field empty on failure', async () => {
    svc.setApiKey.mockRejectedValue(new Error('invalid key'));
    render(<ApiKeyForm harnessId="codex-cli" label="使用 OpenAI API Key" />);
    const input = screen.getByLabelText('使用 OpenAI API Key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-bad' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('api-key-form'));
    });
    expect(screen.getByText('invalid key')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('does not submit an empty key', async () => {
    render(<ApiKeyForm harnessId="codex-cli" label="k" />);
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
    await act(async () => {
      fireEvent.submit(screen.getByTestId('api-key-form'));
    });
    expect(svc.setApiKey).not.toHaveBeenCalled();
  });
});
