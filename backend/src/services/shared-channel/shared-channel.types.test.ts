import {
  isSharedChannelMessagePush, isSharedChannelRevokedPush, parseSharedChannelLink, parseSharedChannelLinks,
  parseSharedChannelMessage, parseSharedChannelPage, parseSharedChannelPostAnswer, unwrapCloudData, externalChannelIdOf,
} from './shared-channel.types.js';

describe('shared channel wire guards', () => {
  it('accepts well-formed pushes and nothing else', () => {
    expect(isSharedChannelMessagePush({ v: 1, linkId: 'l', messageId: 'm' })).toBe(true);
    expect(isSharedChannelMessagePush({ v: 2, linkId: 'l', messageId: 'm' })).toBe(false);
    expect(isSharedChannelMessagePush({ v: 1, linkId: 'l' })).toBe(false);
    expect(isSharedChannelMessagePush(null)).toBe(false);
    expect(isSharedChannelMessagePush('x')).toBe(false);
    expect(isSharedChannelRevokedPush({ v: 1, linkId: 'l' })).toBe(true);
    expect(isSharedChannelRevokedPush({ v: 1, linkId: ' ' })).toBe(false);
    expect(isSharedChannelRevokedPush([])).toBe(false);
  });

  it('parses links, dropping unusable rows', () => {
    expect(parseSharedChannelLink({ linkId: 'l', status: 'active', counterpartDisplayName: 'Acme', counterpartEmail: 'a@b.c', acceptedAt: 't' }))
      .toEqual({ linkId: 'l', status: 'active', counterpartDisplayName: 'Acme', counterpartEmail: 'a@b.c', acceptedAt: 't' });
    expect(parseSharedChannelLink({ linkId: 'l', status: 'pending' })).toBeNull();
    expect(parseSharedChannelLink({ status: 'active' })).toBeNull();
    expect(parseSharedChannelLinks({ links: [{ linkId: 'l', status: 'revoked' }, 5, {}] })).toHaveLength(1);
    expect(parseSharedChannelLinks(null)).toEqual([]);
  });

  it('parses messages and pages', () => {
    const m = { id: 'm1', linkId: 'l', direction: 'received', fromAgentName: 'Fern', fromTeam: 'Ops', text: 'hi', createdAt: '2026-11-10T00:00:00Z', status: 'delivered' };
    expect(parseSharedChannelMessage(m)).toMatchObject({ id: 'm1', direction: 'received', fromAgentName: 'Fern', text: 'hi' });
    expect(parseSharedChannelMessage({ ...m, text: '' })).toBeNull();
    expect(parseSharedChannelMessage({ ...m, direction: 'weird' })).toBeNull();
    expect(parseSharedChannelMessage({ ...m, text: 'x'.repeat(20000) })?.text.length).toBe(8000);
    expect(parseSharedChannelPage({ messages: [m, {}], hasMore: true })).toEqual({ messages: [expect.objectContaining({ id: 'm1' })], hasMore: true });
    expect(parseSharedChannelPage({ hasMore: true })).toBeNull();
  });

  it('unwraps the Cloud {success, data} envelope', () => {
    const links = unwrapCloudData({ success: true, data: { links: [{ linkId: 'l', status: 'active' }] } });
    expect(parseSharedChannelLinks(links)).toHaveLength(1);
    expect(unwrapCloudData({ links: [] })).toEqual({ links: [] });
  });

  it('parses Cloud\'s answer to a send', () => {
    const message = { id: 'msg-00000001', linkId: 'l', direction: 'sent', fromAgentName: 'Orc', fromTeam: '', text: 'hi', createdAt: '2026-11-10T00:00:00.000Z', status: 'queued' };
    expect(parseSharedChannelPostAnswer(201, { success: true, data: { message, duplicate: false } })).toEqual({ ok: true, messageId: 'msg-00000001', createdAt: '2026-11-10T00:00:00.000Z', duplicate: false });
    expect(parseSharedChannelPostAnswer(200, { success: true, data: { message, duplicate: true } })).toMatchObject({ ok: true, duplicate: true });
    expect(parseSharedChannelPostAnswer(201, { success: true, data: {} })).toMatchObject({ ok: false, code: 'malformed' });
    expect(parseSharedChannelPostAnswer(429, { success: false, error: 'Too many', code: 'rate_limited' }, '30')).toEqual({ ok: false, status: 429, code: 'rate_limited', error: 'Too many', retryAfterS: 30 });
    expect(parseSharedChannelPostAnswer(502, null)).toEqual({ ok: false, status: 502, code: 'http_502', error: 'Crewly Cloud answered 502' });
  });

  it('builds the chat channel id of a link', () => {
    expect(externalChannelIdOf('l-1_a.b')).toBe('external-l-1_a.b');
    expect(externalChannelIdOf('a/b c')).toBe('external-a-b-c');
  });
});
