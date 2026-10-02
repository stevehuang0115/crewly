/**
 * Tests for Settings › Security (approvals and blocks).
 *
 * @module components/Settings/SecurityTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SecurityTab, itemLink, itemMeta } from './SecurityTab';
import { securityService, type ApprovalActivity, type ActivityItem } from '../../services/security.service';

vi.mock('../../services/security.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/security.service')>()),
  securityService: { approvals: vi.fn() },
}));
vi.mock('../../hooks/usePtyStatus', () => ({
  usePtyStatus: () => ({ sessions: [], summary: { totalAgents: 10, isolatedCount: 10, sharedCount: 0, status: 'healthy' }, loading: false, error: null, refresh: vi.fn() }),
}));

const svc = vi.mocked(securityService);
const hour = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function item(over: Partial<ActivityItem>): ActivityItem {
  return { id: 'D-1', category: 'question', title: 'Ship it?', agent: 'Nova', outcome: 'approved', at: hour(2), decisionId: 'D-1', ...over };
}

function activity(over: Partial<ApprovalActivity> = {}): ApprovalActivity {
  return {
    days: 7,
    since: hour(168),
    blocked: { tracked: false, note: 'Not recorded yet.', sources: ['Command guard (blocked shell commands)', 'Mission policy'] },
    asked: 12,
    outcomes: { approved: 7, denied: 2, answered: 0, expired: 1, withdrawn: 0, waiting: 2 },
    browser: { tracked: true, counts: { held: 3, approved: 2, refused: 1, expired: 0, waiting: 0 } },
    sensitive: { total: 3, publish: 2, email: 1, deploy: 0, spend: 0 },
    runtimeTerms: { asked: 1, accepted: 1, declined: 0, waiting: 0 },
    whatsapp: { tracked: false, note: 'Not set up.' },
    gmail: { tracked: true, counts: { waiting: 0 } },
    items: [
      item({ id: 'D-1', category: 'sensitive', sensitive: 'publish', title: 'Publish the post?', answer: 'Yes, publish', requestId: 'r-1' }),
      item({ id: 'D-2', title: 'Deploy now?', outcome: 'waiting' }),
      item({ id: 'p-1', category: 'browser', title: 'click "Submit" on example.com', outcome: 'denied', decisionId: undefined, workItemId: 'wi-3' }),
      ...Array.from({ length: 4 }, (_, i) => item({ id: `D-${10 + i}`, title: `Question ${i}` })),
    ],
    ...over,
  };
}

const renderTab = () =>
  render(
    <MemoryRouter>
      <SecurityTab />
    </MemoryRouter>,
  );

describe('SecurityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.approvals.mockResolvedValue(activity());
  });

  it('shows the counts for 7 days, with "Not tracked yet" for blocks that are not recorded', async () => {
    renderTab();
    expect(await screen.findByTestId('count-asked')).toHaveTextContent('12');
    expect(svc.approvals).toHaveBeenCalledWith(7);
    expect(screen.getByTestId('count-blocked')).toHaveTextContent('Not tracked yet');
    expect(screen.getByLabelText(/Not recorded anywhere yet: Command guard/)).toBeInTheDocument();
    expect(screen.getByTestId('count-outcomes')).toHaveTextContent('7 approved · 2 denied · 1 expired · 2 still waiting');
    expect(screen.getByTestId('count-browser')).toHaveTextContent('3 held · 2 approved · 1 refused');
    expect(screen.getByTestId('count-sensitive')).toHaveTextContent('3 (publish 2 · email 1 · deploy 0 · spend 0)');
    expect(screen.getByTestId('count-terms')).toHaveTextContent('1 asked · 1 accepted · 0 declined');
    // WhatsApp not set up: no row; no Gmail sends waiting: no row.
    expect(screen.queryByTestId('count-whatsapp')).not.toBeInTheDocument();
    expect(screen.queryByTestId('count-gmail')).not.toBeInTheDocument();
    expect(screen.getByTestId('security-isolation')).toHaveTextContent('10 of 10 agents run in their own session');
  });

  it('switches to 30 days', async () => {
    renderTab();
    await screen.findByTestId('count-asked');
    fireEvent.click(screen.getByTestId('security-days-30'));
    await waitFor(() => expect(svc.approvals).toHaveBeenLastCalledWith(30));
  });

  it('lists recent items, five then Show all, linked to their request / run, waiting ones to answer', async () => {
    renderTab();
    const d1 = await screen.findByTestId('security-item-D-1');
    expect(d1).toHaveTextContent('Publish the post?');
    expect(d1).toHaveTextContent('Nova · Sensitive (publish)');
    expect(d1).toHaveTextContent('Approved');
    expect(within(d1).getByRole('link', { name: 'Open request' })).toHaveAttribute('href', '/tickets/requests/r-1');
    expect(within(screen.getByTestId('security-item-D-2')).getByRole('link', { name: 'Answer' })).toHaveAttribute('href', '/');
    expect(within(screen.getByTestId('security-item-p-1')).getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/tickets/runs/wi-3');
    expect(screen.queryByTestId('security-item-D-13')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getByTestId('security-item-D-13')).toBeInTheDocument();
  });

  it('says so when nothing happened, and shows a load error with Retry', async () => {
    svc.approvals.mockRejectedValueOnce(new Error('backend down')).mockResolvedValue(activity({ items: [] }));
    renderTab();
    expect(await screen.findByText(/backend down/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing was asked or held in the last 7 days.')).toBeInTheDocument();
  });
});

describe('itemLink / itemMeta', () => {
  it('links a request, then a run, then a waiting card', () => {
    expect(itemLink(item({ requestId: 'r', workItemId: 'w' }))).toEqual({ to: '/tickets/requests/r', label: 'Open request' });
    expect(itemLink(item({ workItemId: 'w' }))).toEqual({ to: '/tickets/runs/w', label: 'Open run' });
    expect(itemLink(item({ outcome: 'waiting' }))).toEqual({ to: '/', label: 'Answer' });
    expect(itemLink(item({}))).toBeNull();
  });

  it('builds a meta line without ids', () => {
    const meta = itemMeta(item({ category: 'runtime_terms', answer: 'Agree' }));
    expect(meta).toMatch(/^Nova · Runtime terms · .* · "Agree"$/);
    expect(meta).not.toContain('D-1');
  });
});

describe('SecurityTab WhatsApp', () => {
  it('shows replies being sent apart from the ones waiting for you', async () => {
    vi.mocked(securityService.approvals).mockResolvedValue(
      activity({ whatsapp: { tracked: true, counts: { held: 3, sent: 1, discarded: 0, sending: 1, waiting: 1 } }, items: [item({ id: 'w1', category: 'whatsapp', outcome: 'sending', decisionId: undefined })] }),
    );
    renderTab();
    expect(await screen.findByTestId('count-whatsapp')).toHaveTextContent('3 held · 1 sent · 0 discarded · 1 sending · 1 waiting');
    expect(screen.getByTestId('security-item-w1')).toHaveTextContent('Sending');
  });
});
