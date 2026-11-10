import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const cloudClient = { getToken: jest.fn(() => 'tok'), getCloudUrl: jest.fn(() => 'https://cloud.test/') };
jest.mock('../cloud/cloud-client.service.js', () => ({ CloudClientService: { getInstance: () => cloudClient } }));
const chat = { recordExternalMessage: jest.fn(), markExternalChannelRevoked: jest.fn() };
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({ peekChatV2Service: () => chat }));
const fetchMock = jest.fn();
(globalThis as { fetch: unknown }).fetch = fetchMock;

import { buildSharedChannelDeps, setSharedChannelChat } from './shared-channel.wiring.js';

describe('shared channel wiring', () => {
  let home: string;
  beforeEach(() => {
    jest.clearAllMocks();
    home = mkdtempSync(join(tmpdir(), 'sc-wiring-'));
    setSharedChannelChat(null);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists links with the machine token', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ links: [{ linkId: 'l1', status: 'active', counterpartDisplayName: 'Acme', counterpartEmail: 'a@b.c' }] }) });
    const links = await buildSharedChannelDeps(home).listLinks();
    expect(links).toEqual([expect.objectContaining({ linkId: 'l1', status: 'active' })]);
    expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/api/cloud/shared-channels', expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }));
  });

  it('fetches a page after a cursor and returns null when Cloud errors', async () => {
    const deps = buildSharedChannelDeps(home);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [], hasMore: false }) });
    expect(await deps.fetchMessages('l 1', 'm/9', 100)).toEqual({ messages: [], hasMore: false });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cloud.test/api/cloud/shared-channels/l%201/messages?limit=100&after=m%2F9');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await deps.fetchMessages('l1', undefined, 100)).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await deps.listLinks()).toBeNull();
  });

  it('does not call Cloud without a token', async () => {
    cloudClient.getToken.mockReturnValueOnce(null as unknown as string);
    expect(await buildSharedChannelDeps(home).listLinks()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mirrors into chat and reports whether the row is new', () => {
    const deps = buildSharedChannelDeps(home);
    chat.recordExternalMessage.mockReturnValueOnce('row1').mockReturnValueOnce(null);
    const input = { linkId: 'l1', counterpart: 'Acme', messageId: 'm1', senderName: 'Fern (Acme)', direction: 'received' as const, text: 'hi', createdAtMs: 1 };
    expect(deps.mirror(input)).toBe(true);
    expect(deps.mirror(input)).toBe(false);
    expect(chat.recordExternalMessage).toHaveBeenCalledWith(expect.objectContaining({ linkId: 'l1', text: 'hi' }));
  });

  it('marks a channel revoked through chat and keeps cursors in the Crewly home', () => {
    const deps = buildSharedChannelDeps(home);
    deps.markRevoked('l1', 'Acme');
    expect(chat.markExternalChannelRevoked).toHaveBeenCalledWith('l1', 'Acme');
    deps.cursors.set('l1', 'm3');
    expect(buildSharedChannelDeps(home).cursors.get('l1')).toBe('m3');
  });
});
