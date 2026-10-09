/**
 * Tests for the draft-only Zoho path (CREW-400): whatever the caller passes,
 * the upstream call is a draft.
 *
 * @module services/connector/zoho-draft.service.test
 */

import { buildDraftBody, findAccountId, saveZohoDraft, ZohoDraftError, type ZohoDraftDeps } from './zoho-draft.service.js';

jest.mock('../core/logger.service.js', () => ({ LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) } }));

const json = (body: unknown, status = 200) => ({ status, ok: status < 300, headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(body) });

let calls: Array<{ method: string; params?: { name?: string; arguments?: Record<string, unknown> } }>;
let deps: ZohoDraftDeps;

beforeEach(() => {
  calls = [];
  deps = {
    servers: () => ({ list: async () => [{ id: 'zoho', label: 'Zoho', url: 'https://x.zohomcp.com/k/SECRETKEY99/mcp', provider: 'zoho' as const, createdAt: '' }] }),
    auth: () => ({ usesOAuth: async () => true, getAccessToken: async () => 'AT' }),
    fetchImpl: async (_u, init) => {
      const msg = JSON.parse(init.body ?? '{}');
      calls.push(msg);
      if (msg.id === undefined) return json({}, 202);
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } });
      if (msg.params.name === 'ZohoMail_getMailAccounts') {
        return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ text: JSON.stringify({ data: [{ accountId: '4242', primaryEmailAddress: 'info@crewlyai.com' }] }) }] } });
      }
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ text: '{"status":"ok"}' }] } });
    },
  };
});

const draftCall = () => calls.find((c) => c.params?.name === 'ZohoMail_sendEmail')!;

it('forces mode=draft when the caller omits mode', async () => {
  const out = await saveZohoDraft({ fromAddress: 'info@crewlyai.com', toAddress: 'a@b.c', subject: 'Hi', content: 'x' }, deps);
  expect(out.accountId).toBe('4242');
  const body = draftCall().params!.arguments!.body as Record<string, unknown>;
  expect(body.mode).toBe('draft');
  expect(draftCall().params!.arguments!.path_variables).toEqual({ accountId: '4242' });
});

it.each([['send'], ['template'], [undefined], ['']])('still drafts when the caller passes mode=%p and scheduling/attachments', async (mode) => {
  await saveZohoDraft({ fromAddress: 'info@crewlyai.com', toAddress: 'a@b.c', mode, isSchedule: true, scheduleType: 1, askReceipt: 'yes', attachments: [{ attachmentName: 'x' }] } as never, deps);
  const body = draftCall().params!.arguments!.body as Record<string, unknown>;
  expect(body.mode).toBe('draft');
  expect(Object.keys(body).sort()).toEqual(['fromAddress', 'mode', 'toAddress']);
});

it('only ever calls the draft tool with mode draft (never a bare send)', async () => {
  await saveZohoDraft({ fromAddress: 'info@crewlyai.com', toAddress: 'a@b.c' }, deps);
  const sends = calls.filter((c) => c.params?.name === 'ZohoMail_sendEmail');
  expect(sends).toHaveLength(1);
  expect((sends[0].params!.arguments!.body as { mode: string }).mode).toBe('draft');
});

it('needs from and to; reports unknown accounts and a missing connector', async () => {
  expect(() => buildDraftBody({ toAddress: 'a@b.c' })).toThrow(ZohoDraftError);
  await expect(saveZohoDraft({ fromAddress: 'nobody@x.y', toAddress: 'a@b.c' }, deps)).rejects.toMatchObject({ status: 404 });
  await expect(saveZohoDraft({ fromAddress: 'a@b.c', toAddress: 'a@b.c' }, { ...deps, servers: () => ({ list: async () => [] }) })).rejects.toMatchObject({ status: 404 });
  expect(calls.some((c) => c.params?.name === 'ZohoMail_sendEmail')).toBe(false);
});

it('uses a supplied numeric accountId and skips the lookup', async () => {
  await saveZohoDraft({ fromAddress: 'a@b.c', toAddress: 'd@e.f', accountId: '77' }, deps);
  expect(calls.some((c) => c.params?.name === 'ZohoMail_getMailAccounts')).toBe(false);
  expect(draftCall().params!.arguments!.path_variables).toEqual({ accountId: '77' });
});

it('finds account ids in array and {data} shapes', () => {
  expect(findAccountId([{ accountId: 1, emailAddress: [{ mailId: 'A@B.c' }] }], 'a@b.c')).toBe('1');
  expect(findAccountId({ data: [] }, 'a@b.c')).toBeUndefined();
});
