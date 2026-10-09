/**
 * Tests for the machine half of the Drive mode wire shapes.
 */

import { isDrivePayload, parseDeliveryFetch, parseDriveRelayData, parseRecallFetch, parseStateFetch } from './drive-cloud.contract.js';

const SID = 'drv_abcdefghijkl';

describe('parseDriveRelayData', () => {
  it('accepts the three ops', () => {
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, id: 'd1', instanceId: 'mac' })).toEqual({ v: 1, kind: 'drive', op: 'deliver', sessionId: SID, id: 'd1', instanceId: 'mac' });
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'end', sessionId: SID, instanceId: 'mac' })?.op).toBe('end');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'warm', sessionId: SID, instanceId: 'mac' })?.op).toBe('warm');
    expect(parseDriveRelayData({ v: 1, kind: 'drive', op: 'recall', sessionId: SID, instanceId: 'mac' })).toBeNull();
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
