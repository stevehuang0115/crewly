/**
 * Tests for OrcHarnessPicker: orc selection.
 *
 * @module components/Harness/OrcHarnessPicker.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { OrcHarnessPicker, defaultOrcChoice } from './OrcHarnessPicker';
import { makeHarness, ANTIGRAVITY, CODEX, GEMINI } from '../../test/harness.fixtures';

describe('defaultOrcChoice', () => {
  it('keeps the current choice when installed', () => {
    expect(defaultOrcChoice([makeHarness(), CODEX], 'codex-cli')).toBe('codex-cli');
  });

  it('uses the preferred harness next, then Claude Code, then the first installed', () => {
    expect(defaultOrcChoice([makeHarness(), CODEX], null, 'codex-cli')).toBe('codex-cli');
    expect(defaultOrcChoice([makeHarness(), CODEX], null)).toBe('claude-code');
    expect(defaultOrcChoice([makeHarness({ installed: false }), CODEX], 'claude-code')).toBe('codex-cli');
    expect(defaultOrcChoice([GEMINI], null)).toBeNull();
  });

  it('never defaults to a retired harness unless it is already the orc harness', () => {
    const installedGemini = { ...GEMINI, installed: true };
    expect(defaultOrcChoice([installedGemini], null)).toBeNull();
    expect(defaultOrcChoice([installedGemini], 'gemini-cli')).toBe('gemini-cli');
  });
});

describe('OrcHarnessPicker', () => {
  it('lists only installed harnesses with the current one checked', () => {
    render(<OrcHarnessPicker harnesses={[makeHarness(), CODEX, GEMINI]} value="claude-code" onChange={vi.fn()} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['claude-code', 'codex-cli']);
    expect(radios[0].checked).toBe(true);
    expect(screen.queryByText('Gemini CLI')).not.toBeInTheDocument();
  });

  it('reports a change', () => {
    const onChange = vi.fn();
    render(<OrcHarnessPicker harnesses={[makeHarness(), CODEX]} value="claude-code" onChange={onChange} />);
    fireEvent.click(screen.getByDisplayValue('codex-cli'));
    expect(onChange).toHaveBeenCalledWith('codex-cli');
  });

  it('disables radios while saving', () => {
    render(<OrcHarnessPicker harnesses={[makeHarness()]} value="claude-code" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('radio')).toBeDisabled();
  });

  it('offers a retired harness (Gemini CLI) only while it is the current choice, labelled', () => {
    const installedGemini = { ...GEMINI, installed: true, version: '0.61.0' };
    const { unmount } = render(<OrcHarnessPicker harnesses={[makeHarness(), installedGemini]} value="claude-code" onChange={vi.fn()} />);
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.value)).toEqual(['claude-code']);
    unmount();
    render(<OrcHarnessPicker harnesses={[makeHarness(), installedGemini]} value="gemini-cli" onChange={vi.fn()} />);
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.value)).toEqual(['claude-code', 'gemini-cli']);
    expect(screen.getByText('Gemini CLI (enterprise only)')).toBeInTheDocument();
  });

  it('offers an installed Antigravity CLI', () => {
    render(<OrcHarnessPicker harnesses={[makeHarness(), { ...ANTIGRAVITY, installed: true }]} value="claude-code" onChange={vi.fn()} />);
    expect(screen.getByText('Antigravity CLI')).toBeInTheDocument();
  });

  it('shows an empty state when nothing is installed', () => {
    render(<OrcHarnessPicker harnesses={[GEMINI]} value={null} onChange={vi.fn()} />);
    expect(screen.getByText('还没有安装任何编程助手')).toBeInTheDocument();
  });
});
