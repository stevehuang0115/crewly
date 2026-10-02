/**
 * Tests for Settings → Runtimes → Terms of Service.
 *
 * @module components/Settings/RuntimeTermsPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimeTermsPanel, termsStatus } from './RuntimeTermsPanel';
import { runtimeFallbackService, type RuntimeTermsView } from '../../services/runtime-fallback.service';

vi.mock('../../services/runtime-fallback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/runtime-fallback.service')>()),
  runtimeFallbackService: {
    getTerms: vi.fn(),
    requestTerms: vi.fn(),
    probeTerms: vi.fn(),
    answerTerms: vi.fn(),
  },
}));

const svc = vi.mocked(runtimeFallbackService);

function view(over: Partial<RuntimeTermsView> = {}): RuntimeTermsView {
  return {
    runtime: 'antigravity-cli',
    label: 'Antigravity CLI',
    status: 'declined',
    reason: "You chose Don't agree",
    blockedReason: "Terms not accepted: You chose Don't agree",
    info: {
      summary: "Google's Antigravity CLI Terms of Service and the Google Privacy Policy.",
      dataItem: 'Yes, I agree to help improve Antigravity CLI by allowing Google to collect and use my Interactions data…',
      links: [
        { label: 'Terms of Service', url: 'https://antigravity.google/terms' },
        { label: 'Privacy Policy', url: 'https://policies.google.com/privacy' },
      ],
    },
    choices: [
      { choice: 'agree_no_data', label: 'Agree, no data sharing' },
      { choice: 'agree_share_data', label: 'Agree + share data' },
      { choice: 'decline', label: "Don't agree" },
    ],
    ...over,
  };
}

describe('RuntimeTermsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports its list, and a row\'s "Accept terms…" (focus) asks once per press', async () => {
    svc.getTerms.mockResolvedValue([view()]);
    svc.requestTerms.mockResolvedValue(view({ status: 'pending' }));
    const onViews = vi.fn();
    const { rerender } = render(<RuntimeTermsPanel onViews={onViews} focus={{ runtime: 'antigravity-cli', nonce: 1 }} />);
    expect(await screen.findByTestId('runtime-terms-choices-antigravity-cli')).toBeInTheDocument();
    expect(onViews).toHaveBeenCalledWith([expect.objectContaining({ runtime: 'antigravity-cli' })]);
    expect(svc.requestTerms).toHaveBeenCalledTimes(1);
    rerender(<RuntimeTermsPanel onViews={onViews} focus={{ runtime: 'antigravity-cli', nonce: 1 }} />);
    rerender(<RuntimeTermsPanel onViews={onViews} focus={{ runtime: 'antigravity-cli', nonce: 2 }} />);
    await waitFor(() => expect(svc.requestTerms).toHaveBeenCalledTimes(2));
  });

  it('shows why a runtime is skipped', async () => {
    svc.getTerms.mockResolvedValue([view()]);
    render(<RuntimeTermsPanel />);
    expect(await screen.findByTestId('runtime-terms-status-antigravity-cli')).toHaveTextContent("Terms not accepted: You chose Don't agree");
  });

  it('Accept terms… posts the card and shows the same three choices inline, with the data item separately', async () => {
    svc.getTerms.mockResolvedValue([view()]);
    svc.requestTerms.mockResolvedValue(view({ status: 'pending' }));
    svc.answerTerms.mockResolvedValue(view({ status: 'accepting' }));
    render(<RuntimeTermsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept terms/ }));
    const choices = await screen.findByTestId('runtime-terms-choices-antigravity-cli');
    expect(svc.requestTerms).toHaveBeenCalledWith('antigravity-cli');
    expect(choices).toHaveTextContent('A separate item, pre-checked on the screen:');
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', 'https://antigravity.google/terms');
    expect(screen.getByText(/A card was also sent to your Slack DM/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Agree, no data sharing' }));
    await waitFor(() => expect(svc.answerTerms).toHaveBeenCalledWith('antigravity-cli', 'agree_no_data'));
    expect(await screen.findByText(/Accepting now/)).toBeInTheDocument();
  });

  it('Check reports a runtime that is already set up', async () => {
    svc.getTerms.mockResolvedValue([view({ status: 'none', blockedReason: null })]);
    svc.probeTerms.mockResolvedValue({ outcome: 'ready', screen: '' });
    render(<RuntimeTermsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Check/ }));
    expect(await screen.findByText(/already accepted on this machine/)).toBeInTheDocument();
  });

  it('renders nothing when no runtime has a Terms flow, and shows an error', async () => {
    svc.getTerms.mockResolvedValueOnce([]);
    const { container } = render(<RuntimeTermsPanel />);
    await waitFor(() => expect(svc.getTerms).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('termsStatus wording (English)', () => {
    expect(termsStatus(view({ status: 'accepted', dataSharing: false })).text).toBe('Accepted · data sharing off');
    expect(termsStatus(view({ status: 'pending' })).text).toMatch(/Slack DM from Crewly Orc/);
    expect(termsStatus(view({ status: 'none' })).text).toMatch(/Not seen on this machine yet/);
  });
});
