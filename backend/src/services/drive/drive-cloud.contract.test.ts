/**
 * Tests for the machine half of the Drive mode wire shapes.
 */

import { MEETING_THREAD_REF, isDrivePayload, parseDeliveryFetch, parseDriveRelayData, parseMeetingPackFetch, parseRecallFetch, parseStateFetch, parseWikiFetch, parseWriteBack } from './drive-cloud.contract.js';

const SID = 'drv_abcdefghijkl';

describe('parseDriveRelayData', () => {
  it('accepts the three ops', () => {
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, id: 'd1', instanceId: 'mac' })).toEqual({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, id: 'd1', instanceId: 'mac' });
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'end', sessionId: SID, instanceId: 'mac' })?.op).toBe('end');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'warm', sessionId: SID, instanceId: 'mac' })?.op).toBe('warm');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'recall', sessionId: SID, instanceId: 'mac' })).toBeNull();
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'refresh', sessionId: SID, id: 'r1', instanceId: 'mac' })?.op).toBe('refresh');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'refresh', sessionId: SID, instanceId: 'mac' })).toBeNull();
  });

  it('refuses Talk payloads, bad ops, bad ids', () => {
    expect(parseDriveRelayData({ v: 1, messageId: 'm1' })).toBeNull();
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'wipe', sessionId: SID, instanceId: 'mac' })).toBeNull();
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, instanceId: 'mac' })).toBeNull();
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'end', sessionId: 'nope', instanceId: 'mac' })).toBeNull();
    expect(isDrivePayload({ kind: 'drive' })).toBe(true);
    expect(isDrivePayload({ messageId: 'x' })).toBe(false);
  });
});

describe('fetch answers', () => {
  it('delivery', () => {
    expect(parseDeliveryFetch({ id: 'd1', sessionId: SID, conversationId: 'c1', text: 'hi', target: { kind: 'team', name: 'CE', agentSession: 'owen', members: ['owen', 1] } })).toEqual({
      id: 'd1',
      sessionId: SID,
      conversationId: 'c1',
      text: 'hi',
      target: { kind: 'team', name: 'CE', agentSession: 'owen', members: ['owen'] },
    });
    expect(parseDeliveryFetch({ id: 'd1', target: {} })).toBeNull();
  });

  it('recall and state', () => {
    expect(parseRecallFetch({ agentSessions: ['ella'], hint: 'x' })).toEqual({ agentSessions: ['ella'], hint: 'x' });
    expect(parseRecallFetch({ agentSessions: [] })).toBeNull();
    expect(parseStateFetch({ ended: true, conversations: [{ conversationId: 'c1', agentSession: 'ella' }, { bad: 1 }] })).toEqual({ ended: true, conversations: [{ conversationId: 'c1', agentSession: 'ella' }], warm: [], warmUntil: 0 });
    expect(parseStateFetch({ ended: false, conversations: [], warm: ['ella', 3, ''], warmUntil: '2026-10-09T10:20:00.000Z' })).toEqual({
      ended: false,
      conversations: [],
      warm: ['ella'],
      warmUntil: Date.parse('2026-10-09T10:20:00.000Z'),
    });
  });
});

describe('op:log', () => {
  it('a log push needs no id', () => {
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'log', sessionId: 'drv_abcdefghijkl', instanceId: 'mac' })).toEqual({ v: 1, kind: 'drive', op: 'log', sessionId: 'drv_abcdefghijkl', instanceId: 'mac' });
  });
});

describe('meetings (P2b)', () => {
  it('meeting_pack and wiki_search pushes need an id', () => {
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'meeting_pack', sessionId: SID, id: SID, instanceId: 'mac' })?.op).toBe('meeting_pack');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'wiki_search', sessionId: SID, id: 'w1', instanceId: 'mac' })?.op).toBe('wiki_search');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'wiki_search', sessionId: SID, instanceId: 'mac' })).toBeNull();
  });

  it('a delivery may carry a write-back; a bad thread ref becomes a new topic', () => {
    const base = { id: 'd1', sessionId: SID, conversationId: 'c1', text: 'Use B', target: { kind: 'agent', name: 'Ella', agentSession: 'ella' } };
    expect(parseDeliveryFetch({ ...base, writeBack: { kind: 'decision', topic: 'Headline', threadRef: 'slack:D0ELLA:1760950000.000100' } })?.writeBack).toEqual({ kind: 'decision', topic: 'Headline', threadRef: 'slack:D0ELLA:1760950000.000100' });
    expect(parseWriteBack({ kind: 'bogus', topic: 'Hiring', threadRef: 'nope', newTopic: 'Hiring' })).toEqual({ kind: 'note', topic: 'Hiring', newTopic: 'Hiring' });
    expect(parseWriteBack({})).toBeNull();
    expect(parseDeliveryFetch(base)?.writeBack).toBeUndefined();
  });

  it('pack and wiki requests', () => {
    expect(parseMeetingPackFetch({ agentSession: 'ella', name: 'Ella', team: 'Marketing', language: 'zh' })).toEqual({ agentSession: 'ella', name: 'Ella', team: 'Marketing', language: 'zh' });
    expect(parseMeetingPackFetch({ name: 'Ella' })).toBeNull();
    expect(parseWikiFetch({ agentSession: 'ella', query: ' brand voice ' })).toEqual({ agentSession: 'ella', query: 'brand voice' });
    expect(parseWikiFetch({ agentSession: 'ella' })).toBeNull();
  });

  it('thread refs', () => {
    expect(MEETING_THREAD_REF.test('chat:dm-ella:4b1c2d3e-0000-4000-8000-000000000001')).toBe(true);
    expect(MEETING_THREAD_REF.test('slack:D0ELLA:1760950000.000100')).toBe(true);
    expect(MEETING_THREAD_REF.test('telegram:1')).toBe(false);
  });
});
