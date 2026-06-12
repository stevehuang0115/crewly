/**
 * Tests for MobileApiRelayService — allowlist, proxying, reply round-trip,
 * and resilience (never hangs the phone).
 *
 * @module services/cloud/mobile-api-relay.service.test
 */

import {
  MobileApiRelayService,
  isAllowedMobileApiCall,
  type MobileRelayIncomingMessage,
  type IMobileRelayCloudSync,
} from './mobile-api-relay.service.js';

const SILENT = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as ConstructorParameters<typeof MobileApiRelayService>[0]['logger'];

/** In-memory cloud-sync stub that captures replies + lets tests inject messages. */
function makeSync() {
  const handlers: Array<(msg: MobileRelayIncomingMessage) => void> = [];
  const sent: Array<{ to: string; type: string; payload: unknown }> = [];
  const sync: IMobileRelayCloudSync = {
    on: (_e, h) => { handlers.push(h); },
    off: (_e, h) => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); },
    sendMessage: async (to, type, payload) => { sent.push({ to, type, payload }); },
  };
  const emit = (msg: MobileRelayIncomingMessage) => { for (const h of [...handlers]) h(msg); };
  return { sync, sent, emit, handlers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('isAllowedMobileApiCall', () => {
  it('allows the read surface', () => {
    expect(isAllowedMobileApiCall('GET', '/teams')).toBe(true);
    expect(isAllowedMobileApiCall('GET', '/escalations')).toBe(true);
    expect(isAllowedMobileApiCall('GET', '/task-pool/items')).toBe(true);
    expect(isAllowedMobileApiCall('GET', '/requests?status=running')).toBe(true);
  });

  it('allows only the human-in-the-loop mutations', () => {
    expect(isAllowedMobileApiCall('POST', '/escalations/abc/resolve')).toBe(true);
    expect(isAllowedMobileApiCall('POST', '/approvals/xyz/approve')).toBe(true);
    expect(isAllowedMobileApiCall('POST', '/teams')).toBe(false);
    expect(isAllowedMobileApiCall('POST', '/task-pool/add')).toBe(false);
  });

  it('rejects traversal, non-rooted, and odd methods', () => {
    expect(isAllowedMobileApiCall('GET', '/teams/../settings')).toBe(false);
    expect(isAllowedMobileApiCall('GET', 'teams')).toBe(false);
    expect(isAllowedMobileApiCall('GET', '//evil')).toBe(false);
    expect(isAllowedMobileApiCall('DELETE', '/teams')).toBe(false);
  });
});

describe('MobileApiRelayService', () => {
  it('proxies an allowed GET to the local API and replies api_response', async () => {
    const { sync, sent, emit } = makeSync();
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [{ id: 't1' }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const svc = new MobileApiRelayService({ cloudSync: sync, webPort: 8787, fetchImpl, logger: SILENT });
    svc.start();

    emit({ type: 'api_request', from: 'phone-1', payload: { id: 'r1', method: 'GET', path: '/teams' } });
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/api/teams', expect.objectContaining({ method: 'GET' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'phone-1', type: 'api_response' });
    const payload = sent[0].payload as { id: string; status: number; body: { success: boolean } };
    expect(payload.id).toBe('r1');
    expect(payload.status).toBe(200);
    expect(payload.body.success).toBe(true);
  });

  it('forwards POST bodies for allowed mutations', async () => {
    const { sync, sent, emit } = makeSync();
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch;
    const svc = new MobileApiRelayService({ cloudSync: sync, webPort: 8787, fetchImpl, logger: SILENT });
    svc.start();

    emit({
      type: 'api_request',
      from: 'phone-1',
      payload: { id: 'r2', method: 'POST', path: '/escalations/e1/resolve', body: { resolution: 'approve' } },
    });
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/escalations/e1/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ resolution: 'approve' }) }),
    );
    expect((sent[0].payload as { status: number }).status).toBe(200);
  });

  it('replies 403 (never silent-drops) for a blocked path', async () => {
    const { sync, sent, emit } = makeSync();
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const svc = new MobileApiRelayService({ cloudSync: sync, webPort: 8787, fetchImpl, logger: SILENT });
    svc.start();

    emit({ type: 'api_request', from: 'phone-1', payload: { id: 'r3', method: 'POST', path: '/settings' } });
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((sent[0].payload as { status: number }).status).toBe(403);
  });

  it('replies 502 when the local API is unreachable', async () => {
    const { sync, sent, emit } = makeSync();
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const svc = new MobileApiRelayService({ cloudSync: sync, webPort: 8787, fetchImpl, logger: SILENT });
    svc.start();

    emit({ type: 'api_request', from: 'phone-1', payload: { id: 'r4', method: 'GET', path: '/teams' } });
    await flush();

    expect((sent[0].payload as { status: number; body: { error: string } }).status).toBe(502);
  });

  it('ignores non-api_request messages and missing sender', async () => {
    const { sync, sent, emit } = makeSync();
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const svc = new MobileApiRelayService({ cloudSync: sync, webPort: 8787, fetchImpl, logger: SILENT });
    svc.start();

    emit({ type: 'chat_request', from: 'phone-1', payload: { id: 'x' } });
    emit({ type: 'api_request', payload: { id: 'r5', method: 'GET', path: '/teams' } }); // no sender
    await flush();

    expect(sent).toHaveLength(0);
  });

  it('start is idempotent and stop detaches', async () => {
    const { sync, emit, sent, handlers } = makeSync();
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const svc = new MobileApiRelayService({ cloudSync: sync, webPort: 8787, fetchImpl, logger: SILENT });
    svc.start();
    svc.start();
    expect(handlers).toHaveLength(1);
    svc.stop();
    emit({ type: 'api_request', from: 'p', payload: { id: 'r6', method: 'GET', path: '/teams' } });
    await flush();
    expect(sent).toHaveLength(0);
  });
});
