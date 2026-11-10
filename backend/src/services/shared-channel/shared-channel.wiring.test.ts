import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const cloudClient = { getToken: jest.fn(() => 'tok'), getCloudUrl: jest.fn(() => 'https://cloud.test/') };
jest.mock('../cloud/cloud-client.service.js', () => ({ CloudClientService: { getInstance: () => cloudClient } }));
const chat = { recordExternalMessage: jest.fn(), recordExternalMessageRow: jest.fn(), markExternalChannelRevoked: jest.fn() };
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({ peekChatV2Service: () => chat }));
const fetchMock = jest.fn();
(globalThis as { fetch: unknown }).fetch = fetchMock;

jest.mock('../cloud/device-identity.service.js', () => ({ DeviceIdentityService: { getInstance: () => ({ getOrCreateIdentity: async () => ({ deviceId: 'dev-1' }) }) } }));
const findMember = jest.fn();
jest.mock('../core/storage.service.js', () => ({ StorageService: { getInstance: () => ({ findMemberBySessionName: findMember }) } }));

import { buildSharedChannelDeps, buildSharedChannelSendDeps, cloudPostSharedMessage, setSharedChannelChat } from './shared-channel.wiring.js';

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

  describe('send side', () => {
    const message = { id: 'msg-00000001', linkId: 'l1', direction: 'sent', fromAgentName: 'Orc', fromTeam: '', text: 'hi', createdAt: '2026-11-10T00:00:00.000Z', status: 'queued' };

    it('POSTs the crewly-auth send body with the machine token', async () => {
      fetchMock.mockResolvedValue({ status: 201, json: async () => ({ success: true, data: { message, duplicate: false } }), headers: { get: () => null } });
      const r = await cloudPostSharedMessage('l 1', { id: 'msg-00000001', text: 'hi', fromAgentName: 'Orc' });
      expect(r).toEqual({ ok: true, messageId: 'msg-00000001', createdAt: '2026-11-10T00:00:00.000Z', duplicate: false });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://cloud.test/api/cloud/shared-channels/l%201/messages');
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } });
      expect(JSON.parse(init.body)).toEqual({ id: 'msg-00000001', text: 'hi', fromAgentName: 'Orc' });
    });

    it('passes Cloud refusals on and never throws', async () => {
      fetchMock.mockResolvedValueOnce({ status: 409, json: async () => ({ success: false, error: 'This link has been revoked', code: 'link_not_active' }), headers: { get: () => null } });
      expect(await cloudPostSharedMessage('l1', { id: 'msg-00000001', text: 'hi', fromAgentName: 'Orc' })).toMatchObject({ ok: false, status: 409, code: 'link_not_active' });
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      expect(await cloudPostSharedMessage('l1', { id: 'msg-00000001', text: 'hi', fromAgentName: 'Orc' })).toMatchObject({ ok: false, status: 0 });
      cloudClient.getToken.mockReturnValueOnce(null as unknown as string);
      expect(await cloudPostSharedMessage('l1', { id: 'msg-00000001', text: 'hi', fromAgentName: 'Orc' })).toMatchObject({ ok: false, status: 0, code: 'not_signed_in' });
    });

    it('files sent messages in chat, names agents, and keeps the trial in the Crewly home', async () => {
      const deps = buildSharedChannelSendDeps(home);
      chat.recordExternalMessageRow.mockReturnValueOnce({ id: 'row9', deduped: true });
      expect(deps.recordSent({ linkId: 'l1', counterpart: 'Acme', messageId: 'm1', senderName: 'Orc', direction: 'sent', text: 'hi', createdAtMs: 1 })).toBe('row9');
      expect(chat.recordExternalMessageRow).toHaveBeenCalledWith(expect.objectContaining({ direction: 'sent', messageId: 'm1' }));
      expect(await deps.agentIdentity('crewly-orc')).toEqual({ name: 'Orc' });
      findMember.mockResolvedValueOnce({ member: { name: 'Vera' }, team: { name: 'CE' } });
      expect(await deps.agentIdentity('ce-vera')).toEqual({ name: 'Vera', team: 'CE' });
      expect(await deps.instanceId?.()).toBe('dev-1');
      expect(deps.newId()).toMatch(/^[0-9a-f-]{36}$/);
      expect(deps.decisions()).toBeNull();
      expect(deps.recentPeople('crewly-orc')).toEqual([]);
      deps.trial.noteApproved('l1');
      expect(buildSharedChannelSendDeps(home).trial.approvedCount('l1')).toBe(1);
    });
  });
});
