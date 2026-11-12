/**
 * Security boundary tests of the support relay (crewly#1558): only
 * relay-vouched requests are served, only under /api/support, only with the
 * role's methods, never encrypted, never with the kill switch off — and
 * every call is audited.
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import type { SupportAuditInput } from './support-audit.service.js';
import { SupportRelayService, type ISupportApi, type ISupportRelayCloudSync, type SupportRelayIncomingMessage } from './support-relay.service.js';
import type { SupportGrantEnvelope } from './support.types.js';

const CODES = SUPPORT_ACCESS_CONSTANTS.CODES;
const SILENT = { info() {}, warn() {} };

const ENVELOPE: SupportGrantEnvelope = {
  grantId: 'g1',
  role: 'viewer',
  includePrivate: false,
  granteeEmail: 'help@crewlyai.com',
  granteeAccountId: 'acct-b',
  replyQueueId: 'q-grantee',
};

function make(opts: { allow?: boolean | (() => Promise<boolean>) } = {}) {
  const handlers: Array<(m: SupportRelayIncomingMessage) => void> = [];
  const sent: Array<{ to: string; type: string; payload: { id: string; status: number; body: unknown } }> = [];
  const sync: ISupportRelayCloudSync = {
    on: (_e, h) => void handlers.push(h),
    off: (_e, h) => void handlers.splice(handlers.indexOf(h), 1),
    sendToPeerQueueId: async (to, type, payload) => void sent.push({ to, type, payload: payload as { id: string; status: number; body: unknown } }),
  };
  const api: ISupportApi & { handle: jest.Mock } = { handle: jest.fn(async () => ({ status: 200, body: { success: true, data: 'ok' } })) };
  const audits: SupportAuditInput[] = [];
  const allow = opts.allow ?? true;
  const relay = new SupportRelayService({
    cloudSync: sync,
    api,
    allowGrantees: typeof allow === 'function' ? allow : async () => allow,
    audit: { note: (i) => (audits.push(i), true) },
    logger: SILENT,
  });
  return { relay, sync, sent, api, audits, handlers };
}

function req(over: Partial<SupportRelayIncomingMessage> = {}, data: Record<string, unknown> = {}): SupportRelayIncomingMessage {
  return {
    type: 'api_request',
    fromDeviceName: 'q-grantee',
    encrypted: false,
    payload: { id: 'r1', method: 'GET', path: '/support/agents', ...data },
    supportGrant: ENVELOPE,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SupportRelayService listener', () => {
  it('handles only api_request messages carrying a grant envelope', async () => {
    const { relay, api, handlers, sent } = make();
    relay.start();
    relay.start();
    expect(handlers).toHaveLength(1);
    // An owner (same-account) request without an envelope is not ours.
    handlers[0](req({ supportGrant: undefined }));
    handlers[0](req({ type: 'chat_request' }));
    await flush();
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    handlers[0](req());
    await flush();
    expect(api.handle).toHaveBeenCalledTimes(1);
    relay.stop();
    expect(handlers).toHaveLength(0);
  });
});

describe('SupportRelayService.handleRequest', () => {
  it('serves a vouched GET as the grantee and answers to the relay-validated queue', async () => {
    const { relay, api, sent, audits } = make();
    await relay.handleRequest(req({ fromDeviceName: 'some-other-queue' }));
    expect(api.handle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'support', grantId: 'g1', role: 'viewer' }), { method: 'GET', path: '/support/agents' });
    expect(sent).toEqual([{ to: 'q-grantee', type: 'api_response', payload: { id: 'r1', status: 200, body: { success: true, data: 'ok' } } }]);
    expect(audits).toEqual([expect.objectContaining({ outcome: 'ok', status: 200, method: 'GET', path: '/support/agents' })]);
  });

  it('the caller handed to the API is never the owner and cannot be widened', async () => {
    const { relay, api } = make();
    await relay.handleRequest(req());
    const caller = api.handle.mock.calls[0][0];
    expect(caller.kind).toBe('support');
    expect(Object.isFrozen(caller)).toBe(true);
  });

  it('ignores a grant smuggled inside data: only the top-level envelope counts', async () => {
    const { relay, api } = make();
    await relay.handleRequest(req({}, { supportGrant: { ...ENVELOPE, role: 'admin' }, method: 'POST', path: '/support/agents/a/restart' }));
    expect(api.handle).not.toHaveBeenCalled();
  });

  it('refuses a grant request for a non-support path', async () => {
    const { relay, api, sent, audits } = make();
    for (const path of ['/teams', '/settings', '/support', '/support/../teams', '/support/%2e%2e/teams', '/supportx/a']) {
      await relay.handleRequest(req({}, { path }));
    }
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent.every((s) => s.payload.status === 403 && (s.payload.body as { code: string }).code === CODES.PATH)).toBe(true);
    expect(audits.every((a) => a.outcome === 'refused' && a.code === CODES.PATH)).toBe(true);
    expect(sent).toHaveLength(6);
  });

  it('refuses POST from a viewer', async () => {
    const { relay, api, sent } = make();
    await relay.handleRequest(req({}, { method: 'POST', path: '/support/agents/a-dev/restart' }));
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent[0].payload).toMatchObject({ status: 403, body: { code: CODES.METHOD } });
  });

  it('lets an admin POST, and refuses methods no role has', async () => {
    const { relay, api, sent } = make();
    await relay.handleRequest(req({ supportGrant: { ...ENVELOPE, role: 'admin' } }, { method: 'POST', path: '/support/agents/a-dev/restart' }));
    expect(api.handle).toHaveBeenCalledTimes(1);
    await relay.handleRequest(req({ supportGrant: { ...ENVELOPE, role: 'admin' } }, { method: 'DELETE', path: '/support/agents' }));
    expect(api.handle).toHaveBeenCalledTimes(1);
    expect(sent[1].payload.status).toBe(403);
  });

  it('serves an agent of the granted account a GET of agents, conversations and errors', async () => {
    const { relay, api, sent, audits } = make();
    const agent = { ...ENVELOPE, actor: 'agent' as const, agentName: 'Nova' };
    for (const path of ['/support/agents', '/support/conversations?limit=30', '/support/conversations/c1/messages?limit=30&direction=backward', '/support/errors?limit=50']) {
      await relay.handleRequest(req({ supportGrant: agent }, { path }));
    }
    expect(api.handle).toHaveBeenCalledTimes(4);
    expect(api.handle.mock.calls[0][0]).toMatchObject({ kind: 'support', actor: 'agent', agentName: 'Nova' });
    expect(sent.every((s) => s.payload.status === 200)).toBe(true);
    expect(audits.every((a) => a.outcome === 'ok' && a.caller?.actor === 'agent')).toBe(true);
  });

  it('refuses anything but GET from an agent, whatever the role, and audits it', async () => {
    const { relay, api, sent, audits } = make();
    const agent = { ...ENVELOPE, role: 'admin' as const, actor: 'agent' as const, agentName: 'Nova' };
    await relay.handleRequest(req({ supportGrant: agent }, { method: 'POST', path: '/support/agents/a-dev/restart' }));
    await relay.handleRequest(req({ supportGrant: agent }, { method: 'DELETE', path: '/support/agents' }));
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent.map((s) => [s.payload.status, (s.payload.body as { code: string }).code])).toEqual([
      [403, CODES.AGENT_READ_ONLY],
      [403, CODES.AGENT_READ_ONLY],
    ]);
    expect((sent[0].payload.body as { error: string }).error).toMatch(/only read/);
    expect(audits).toEqual([
      expect.objectContaining({ outcome: 'refused', status: 403, code: CODES.AGENT_READ_ONLY, caller: expect.objectContaining({ actor: 'agent', agentName: 'Nova' }) }),
      expect.objectContaining({ outcome: 'refused', status: 403, code: CODES.AGENT_READ_ONLY }),
    ]);
  });

  it('refuses settings and every other area to an agent, and audits it', async () => {
    const { relay, api, sent, audits } = make();
    const agent = { ...ENVELOPE, actor: 'agent' as const };
    for (const path of ['/support/settings', '/support/whoami', '/support/settings/agents']) {
      await relay.handleRequest(req({ supportGrant: agent }, { path }));
    }
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent.every((s) => s.payload.status === 403 && (s.payload.body as { code: string }).code === CODES.AGENT_PATH)).toBe(true);
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.outcome === 'refused' && a.code === CODES.AGENT_PATH)).toBe(true);
  });

  it('still lets a person read settings, with or without an actor in the envelope', async () => {
    const { relay, api, audits } = make();
    await relay.handleRequest(req({}, { path: '/support/settings' }));
    await relay.handleRequest(req({ supportGrant: { ...ENVELOPE, actor: 'person' } }, { path: '/support/settings' }));
    expect(api.handle).toHaveBeenCalledTimes(2);
    expect(audits.every((a) => a.outcome === 'ok')).toBe(true);
  });

  it('refuses an encrypted payload', async () => {
    const { relay, api, sent } = make();
    await relay.handleRequest(req({ encrypted: true }));
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent[0].payload).toMatchObject({ status: 403, body: { code: CODES.ENCRYPTED } });
  });

  it('refuses everything while the owner kill switch is off, or unreadable', async () => {
    const off = make({ allow: false });
    await off.relay.handleRequest(req());
    expect(off.api.handle).not.toHaveBeenCalled();
    expect(off.sent[0].payload).toMatchObject({ status: 403, body: { code: CODES.DISABLED } });
    expect(off.audits[0]).toMatchObject({ outcome: 'refused', code: CODES.DISABLED });

    const broken = make({ allow: async () => { throw new Error('settings unreadable'); } });
    await broken.relay.handleRequest(req());
    expect(broken.api.handle).not.toHaveBeenCalled();
    expect(broken.sent[0].payload.status).toBe(403);
  });

  it('drops a malformed envelope without answering, and audits it', async () => {
    const { relay, api, sent, audits } = make();
    await relay.handleRequest(req({ supportGrant: null }));
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(audits[0]).toMatchObject({ caller: null, outcome: 'refused', status: 400 });
  });

  it('drops a request without an id', async () => {
    const { relay, api, sent, audits } = make();
    await relay.handleRequest(req({}, { id: undefined }));
    expect(api.handle).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(audits[0]).toMatchObject({ outcome: 'refused', code: CODES.BAD_REQUEST });
  });

  it('audits API refusals and errors with their codes', async () => {
    const { relay, api, audits } = make();
    api.handle.mockResolvedValueOnce({ status: 404, body: { success: false, code: CODES.NOT_FOUND } });
    api.handle.mockResolvedValueOnce({ status: 500, body: { success: false, code: CODES.UNAVAILABLE } });
    await relay.handleRequest(req());
    await relay.handleRequest(req());
    expect(audits.map((a) => [a.outcome, a.code])).toEqual([
      ['refused', CODES.NOT_FOUND],
      ['error', CODES.UNAVAILABLE],
    ]);
  });

  it('survives a failed reply', async () => {
    const { relay, sync } = make();
    sync.sendToPeerQueueId = async () => {
      throw new Error('relay down');
    };
    await expect(relay.handleRequest(req())).resolves.toBeUndefined();
  });
});
