/**
 * Tests for SharedChannelNormsPanel (crewly#1543 slice 6).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SharedChannelNormsPanel, normSummary } from './SharedChannelNormsPanel';
import type { SharedChannelNorms } from '../../services/shared-channel-norms.service';

const NORMS: SharedChannelNorms = {
  linkId: 'l1',
  norm: '',
  allow: [],
  updatedAt: null,
  allowances: [
    { key: 'money', label: 'Money', detail: 'amounts, prices' },
    { key: 'file_names', label: 'File names and paths', detail: 'names of files' },
  ],
};

function api(over: Partial<SharedChannelNorms> = {}) {
  return {
    get: vi.fn(async () => ({ ...NORMS, ...over })),
    save: vi.fn(async (_l: string, c: { norm?: string; allow?: string[] }) => ({ ...NORMS, norm: c.norm ?? '', allow: c.allow ?? [] })),
  };
}

describe('normSummary', () => {
  it('says what is set', () => {
    expect(normSummary({ norm: '', allow: [] })).toContain('No norm yet');
    expect(normSummary({ norm: 'x', allow: ['money'] })).toBe('Norm set · 1 kind allowed without asking');
    expect(normSummary({ norm: '', allow: ['money', 'file_names'] })).toBe('No norm text · 2 kinds allowed without asking');
    expect(normSummary({ norm: 'x', allow: [] })).toBe('Norm set · no kinds allowed without asking');
  });
});

describe('SharedChannelNormsPanel', () => {
  it('loads the norm, edits text and allowances, and saves', async () => {
    const a = api();
    render(<SharedChannelNormsPanel linkId="l1" counterpart="Acme Co" api={a} />);
    await waitFor(() => expect(screen.getByTestId('shared-norms-summary')).toHaveTextContent('No norm yet'));
    expect(a.get).toHaveBeenCalledWith('l1');
    fireEvent.click(screen.getByTestId('shared-norms-toggle'));
    expect(screen.getByTestId('shared-norms-save')).toBeDisabled();
    expect(screen.getByText('What Acme Co may be told')).toBeInTheDocument();
    expect(screen.getByText(/never sent by an agent/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('shared-norms-text'), { target: { value: 'Printer partner' } });
    fireEvent.click(screen.getByTestId('shared-norms-allow-money'));
    fireEvent.click(screen.getByTestId('shared-norms-save'));
    await waitFor(() => expect(screen.getByTestId('shared-norms-saved')).toBeInTheDocument());
    expect(a.save).toHaveBeenCalledWith('l1', { norm: 'Printer partner', allow: ['money'] });
    expect(screen.getByTestId('shared-norms-summary')).toHaveTextContent('Norm set · 1 kind allowed without asking');
  });

  it('shows a saved norm as checked', async () => {
    render(<SharedChannelNormsPanel linkId="l1" counterpart="Acme Co" api={api({ norm: 'Hi', allow: ['file_names'] })} />);
    await waitFor(() => expect(screen.getByTestId('shared-norms-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('shared-norms-toggle'));
    expect(screen.getByTestId('shared-norms-allow-file_names')).toBeChecked();
    expect(screen.getByTestId('shared-norms-allow-money')).not.toBeChecked();
    expect(screen.getByTestId('shared-norms-text')).toHaveValue('Hi');
  });

  it("shows the server's error on a failed save and on a failed load", async () => {
    const a = api();
    a.save.mockRejectedValueOnce(new Error('secret can never be allowed by a norm'));
    render(<SharedChannelNormsPanel linkId="l1" counterpart="Acme Co" api={a} />);
    await waitFor(() => expect(screen.getByTestId('shared-norms-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('shared-norms-toggle'));
    fireEvent.click(screen.getByTestId('shared-norms-allow-money'));
    fireEvent.click(screen.getByTestId('shared-norms-save'));
    await waitFor(() => expect(screen.getByText('secret can never be allowed by a norm')).toBeInTheDocument());

    const failing = { get: vi.fn(async () => { throw new Error('Only the owner sets what another company may be told.'); }), save: vi.fn() };
    render(<SharedChannelNormsPanel linkId="l2" counterpart="Beta" api={failing} />);
    await waitFor(() => expect(screen.getByText(/Only the owner sets/)).toBeInTheDocument());
  });
});
