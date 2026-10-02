/**
 * Tests for the approval activity aggregator (Settings › Security).
 */
import {
  ApprovalActivityService,
  classifyAnswer,
  decisionCategory,
  decisionOutcome,
  parseActivityDays,
  type ApprovalActivityDeps,
} from './approval-activity.service.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { HeldBrowserAction } from '../browser/held-action-store.js';
import type { WhatsAppDraft } from '../../types/whatsapp.types.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function decision(over: Partial<OwnerDecision>): OwnerDecision {
  return {
    id: 'D-1',
    question: 'Publish the post?',
    options: [
      { key: 'a', label: 'Yes, publish' },
      { key: 'b', label: "Don't publish" },
    ],
    defaultKey: 'wait',
    deadline: ago(-1),
    requestedBy: 'ce-nova',
    asker: 'ce-nova',
    status: 'open',
    createdAt: ago(1),
    updatedAt: ago(1),
    ...over,
  } as OwnerDecision;
}

function hold(over: Partial<HeldBrowserAction>): HeldBrowserAction {
  return { pendingId: 'p1', agentSession: 'ce-vera', tool: 'click', description: '', matched: 'submitting', target: 'click "Submit"', raisedAt: NOW.getTime() - DAY, status: 'pending', ...over };
}

function draft(over: Partial<WhatsAppDraft>): WhatsAppDraft {
  return { id: 'w1', code: 'W1', seq: 1, chatId: 'c', text: 'hi', status: 'pending', createdAt: NOW.getTime() - DAY, createdBy: 'ce-owen', sentAt: null, discardedAt: null, lastError: null, ...over };
}

function deps(over: Partial<ApprovalActivityDeps> = {}): ApprovalActivityDeps {
  return {
    decisions: async () => [],
    browserHolds: async () => [],
    whatsappDrafts: async () => null,
    gmailHeld: () => [],
    nameOf: (s) => ({ 'ce-nova': 'Nova', 'ce-vera': 'Vera' } as Record<string, string>)[s],
    now: () => NOW,
    ...over,
  };
}

describe('classifyAnswer / decisionOutcome / decisionCategory', () => {
  it('reads yes / no from the chosen label', () => {
    expect(classifyAnswer('Yes, publish')).toBe('approved');
    expect(classifyAnswer("Don't agree")).toBe('denied');
    expect(classifyAnswer('Agree, no data sharing')).toBe('approved');
    expect(classifyAnswer('Keep stopped')).toBe('denied');
    expect(classifyAnswer('Option B')).toBe('answered');
    expect(classifyAnswer(undefined)).toBe('answered');
  });

  it('maps statuses', () => {
    expect(decisionOutcome(decision({ status: 'parked' })).outcome).toBe('waiting');
    expect(decisionOutcome(decision({ status: 'defaulted' })).outcome).toBe('expired');
    expect(decisionOutcome(decision({ status: 'skipped' })).outcome).toBe('withdrawn');
    expect(decisionOutcome(decision({ status: 'resolved', chosenKey: 'b' }))).toEqual({ outcome: 'denied', answer: "Don't publish" });
  });

  it('categorises', () => {
    expect(decisionCategory({ kind: 'browser_action' })).toBe('browser');
    expect(decisionCategory({ kind: 'runtime_terms' })).toBe('runtime_terms');
    expect(decisionCategory({ kind: 'spend_cap' })).toBe('spend_cap');
    expect(decisionCategory({ sensitive: 'deploy' })).toBe('sensitive');
    expect(decisionCategory({})).toBe('question');
  });

  it('accepts 7 or 30 days', () => {
    expect(parseActivityDays('30')).toBe(30);
    expect(parseActivityDays('90')).toBe(30);
    expect(parseActivityDays(undefined)).toBe(7);
    expect(parseActivityDays('abc')).toBe(7);
  });
});

describe('ApprovalActivityService', () => {
  it('counts asks, outcomes, sensitive kinds and Terms; old waiting cards still count as waiting', async () => {
    const decisions = [
      decision({ id: 'D-1', sensitive: 'publish', status: 'resolved', chosenKey: 'a', requestRef: { requestId: 'r1', itemId: 'i1' } as never }),
      decision({ id: 'D-2', sensitive: 'email', status: 'resolved', chosenKey: 'b' }),
      decision({ id: 'D-3', status: 'expired' }),
      decision({ id: 'D-4', status: 'open', createdAt: ago(20) }), // older than 7 days, still waiting
      decision({ id: 'D-5', status: 'resolved', chosenKey: 'a', createdAt: ago(20) }), // outside the window
      decision({ id: 'D-6', kind: 'runtime_terms', options: [{ key: 'a', label: 'Agree, no data sharing' }], status: 'resolved', chosenKey: 'a', title: 'Antigravity CLI terms' }),
      decision({ id: 'D-7', status: 'cancelled', workItemId: 'wi-9' }),
    ];
    const r = await new ApprovalActivityService(deps({ decisions: async () => decisions })).query(7);
    expect(r.days).toBe(7);
    expect(r.asked).toBe(5);
    expect(r.outcomes).toEqual({ approved: 2, denied: 1, answered: 0, expired: 1, withdrawn: 1, waiting: 1 });
    expect(r.sensitive).toEqual({ total: 2, publish: 1, email: 1, deploy: 0, spend: 0 });
    expect(r.runtimeTerms).toEqual({ asked: 1, accepted: 1, declined: 0, waiting: 0 });
    expect(r.blocked.tracked).toBe(false);
    expect(r.blocked.sources).toContain('Command guard (blocked shell commands)');
    const d1 = r.items.find((x) => x.id === 'D-1');
    expect(d1).toMatchObject({ category: 'sensitive', sensitive: 'publish', agent: 'Nova', outcome: 'approved', answer: 'Yes, publish', requestId: 'r1', decisionId: 'D-1' });
    expect(r.items.find((x) => x.id === 'D-7')).toMatchObject({ outcome: 'withdrawn', workItemId: 'wi-9' });
    expect(r.items.find((x) => x.id === 'D-6')?.title).toBe('Antigravity CLI terms');
    expect(r.items.some((x) => x.id === 'D-5')).toBe(false);
  });

  it('counts browser holds; a hold with a card is listed once (as its card)', async () => {
    const holds = [
      hold({ pendingId: 'p1', status: 'approved', decisionId: 'D-9' }),
      hold({ pendingId: 'p2', status: 'rejected', where: 'example.com/form' }),
      hold({ pendingId: 'p3', status: 'timed_out' }),
      hold({ pendingId: 'p4', status: 'pending', raisedAt: NOW.getTime() - 9 * DAY }),
    ];
    const decisions = [decision({ id: 'D-9', kind: 'browser_action', status: 'resolved', chosenKey: 'a', options: [{ key: 'a', label: 'Allow' }] })];
    const r = await new ApprovalActivityService(deps({ decisions: async () => decisions, browserHolds: async () => holds })).query(30);
    expect(r.browser).toMatchObject({ tracked: true, counts: { held: 4, approved: 1, refused: 1, expired: 1, waiting: 1 } });
    expect(r.browser.note).toMatch(/kept 7 days/);
    expect(r.items.filter((x) => x.category === 'browser').map((x) => x.id).sort()).toEqual(['D-9', 'p2', 'p3', 'p4']);
    expect(r.items.find((x) => x.id === 'p2')).toMatchObject({ title: 'click "Submit" on example.com/form', outcome: 'denied', agent: 'Vera' });
  });

  it('marks sources that are not running as not tracked', async () => {
    const r = await new ApprovalActivityService(deps({ browserHolds: async () => null, whatsappDrafts: async () => null })).query(7);
    expect(r.browser.tracked).toBe(false);
    expect(r.whatsapp.tracked).toBe(false);
  });

  it('counts agent WhatsApp drafts and lists Gmail sends waiting now, newest first', async () => {
    const drafts = [
      draft({ id: 'w1', status: 'sent', sentAt: NOW.getTime() - DAY / 2 }),
      draft({ id: 'w2', status: 'discarded', discardedAt: NOW.getTime() }),
      draft({ id: 'w3', status: 'pending' }),
      draft({ id: 'w4', status: 'sent', createdBy: null }), // the owner's own: not a hold
    ];
    const gmail = [{ id: 'g1', agentSession: 'ce-nova', draftId: 'x', to: 'a@b.c', subject: 'Hello', heldAt: NOW.getTime() - 1000 }];
    const r = await new ApprovalActivityService(deps({ whatsappDrafts: async () => drafts, gmailHeld: () => gmail as never })).query(7);
    expect(r.whatsapp).toMatchObject({ tracked: true, counts: { held: 3, sent: 1, discarded: 1, waiting: 1 } });
    expect(r.gmail.counts).toEqual({ waiting: 1 });
    expect(r.items[0]).toMatchObject({ id: 'g1', category: 'gmail', outcome: 'waiting', title: 'Email "Hello" to a@b.c' });
  });

  it('survives a failing source', async () => {
    const r = await new ApprovalActivityService(
      deps({ decisions: async () => Promise.reject(new Error('x')), gmailHeld: () => { throw new Error('y'); } }),
    ).query(7);
    expect(r.asked).toBe(0);
    expect(r.items).toEqual([]);
  });
});
