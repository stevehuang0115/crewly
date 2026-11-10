import {
  isSharedChannelMessagePush, isSharedChannelRevokedPush, parseSharedChannelLink, parseSharedChannelLinks,
  parseSharedChannelMessage, parseSharedChannelPage, unwrapCloudData,
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
});
