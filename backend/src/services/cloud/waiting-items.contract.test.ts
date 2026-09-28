/**
 * Tests for the "waiting on you" machine-side contract.
 */
import { describe, it, expect } from '@jest/globals';
import type { TicketListItem } from '../v3/ticket-intake.service.js';
import {
  parseWaitingActionFetchResponse,
  parseWaitingActionRelayData,
  toWaitingIngestItem,
} from './waiting-items.contract.js';

function row(over: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id: 'req-1',
    tkt: 'TKT-7',
    ticketNumber: 7,
    title: 'Fix the login page',
    description: 'The login button does nothing',
    kind: 'issue',
    column: 'to_review',
    status: 'waiting_confirmation',
    priority: 'medium',
    priorityLabel: 'P2',
    origin: null,
    assignee: 'dev-sam',
    workItemIds: [],
    tags: [],
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T10:30:00.000Z',
    acceptance: [],
    reply: { at: '2026-09-28T10:00:00.000Z', by: 'dev-ella', messageId: 'm1', excerpt: 'Fixed — the button logs you in now.' },
    rejectCount: 1,
    submitCount: 2,
    submittedAt: '2026-09-28T10:00:00.000Z',
    completedAt: null,
    autoAcceptAt: '2026-09-29T10:00:00.000Z',
    ...over,
  } as TicketListItem;
}

describe('toWaitingIngestItem', () => {
  it('uses the answer, the agent who gave it and when it was handed back', () => {
    expect(toWaitingIngestItem(row(), (s) => (s === 'dev-ella' ? 'Ella' : undefined))).toEqual({
      ticketId: 'req-1',
      tkt: 'TKT-7',
      title: 'Fix the login page',
      excerpt: 'Fixed — the button logs you in now.',
      agentSession: 'dev-ella',
      agentName: 'Ella',
      since: '2026-09-28T10:00:00.000Z',
      autoAcceptAt: '2026-09-29T10:00:00.000Z',
      rejectCount: 1,
      updatedAt: '2026-09-28T10:30:00.000Z',
    });
  });

  it('falls back to the assignee, the description and updatedAt', () => {
    const item = toWaitingIngestItem(row({ reply: null, submittedAt: null, tkt: null, autoAcceptAt: null }));
    expect(item).toMatchObject({ agentSession: 'dev-sam', excerpt: 'The login button does nothing', since: '2026-09-28T10:30:00.000Z', autoAcceptAt: null });
    expect(item.tkt).toBeUndefined();
    expect(item.agentName).toBeUndefined();
  });

  it('cuts very long text', () => {
    const item = toWaitingIngestItem(row({ title: 'x'.repeat(900), reply: { at: '', by: 'a', messageId: 'm', excerpt: 'y'.repeat(5000) } }));
    expect(item.title.length).toBe(500);
    expect(item.title.endsWith('…')).toBe(true);
    expect(item.excerpt?.length).toBe(2000);
  });
});

describe('parseWaitingActionRelayData', () => {
  it('accepts a well-formed push and refuses anything else', () => {
    expect(parseWaitingActionRelayData({ v: 1, actionId: 'a', itemId: 'i', instanceId: 'dev', ticketId: 't', extra: 1 })).toEqual({
      v: 1,
      actionId: 'a',
      itemId: 'i',
      instanceId: 'dev',
      ticketId: 't',
    });
    expect(parseWaitingActionRelayData({ actionId: 'a', itemId: 'i', instanceId: 'dev' })).toBeNull();
    expect(parseWaitingActionRelayData('nope')).toBeNull();
  });
});

describe('parseWaitingActionFetchResponse', () => {
  const base = { actionId: 'a', itemId: 'i', instanceId: 'dev', ticketId: 't', state: 'sent' };
  it('parses accept and send-back', () => {
    expect(parseWaitingActionFetchResponse({ success: true, data: { ...base, kind: 'accept' } })).toEqual({ ...base, kind: 'accept' });
    expect(parseWaitingActionFetchResponse({ success: true, data: { ...base, kind: 'send_back', reason: ' still blue ' } })).toEqual({
      ...base,
      kind: 'send_back',
      reason: 'still blue',
    });
  });

  it('refuses a send-back without a reason, unknown kinds and bad bodies', () => {
    expect(parseWaitingActionFetchResponse({ data: { ...base, kind: 'send_back' } })).toBeNull();
    expect(parseWaitingActionFetchResponse({ data: { ...base, kind: 'delete' } })).toBeNull();
    expect(parseWaitingActionFetchResponse({ data: { kind: 'accept' } })).toBeNull();
    expect(parseWaitingActionFetchResponse(null)).toBeNull();
  });
});
