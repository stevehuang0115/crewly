/**
 * Tests for the per-tool deny policy (CREW-400).
 *
 * @module controllers/connector/remote-mcp-tool-policy.test
 */

import { deniedToolsFor, parseRpc, isDeniedCall, isToolsList, filterToolsResult, filterToolsBody } from './remote-mcp-tool-policy.js';

const denied = deniedToolsFor({ id: 'zoho', provider: 'zoho' });

it('denies zoho send tools by provider or by id, none for other servers', () => {
  expect(denied.has('zohomail_sendemail')).toBe(true);
  expect(denied.has('zohomail_sendreplyemail')).toBe(true);
  expect(deniedToolsFor({ id: 'zoho' }).size).toBe(denied.size);
  expect(deniedToolsFor({ id: 'x', provider: 'custom' }).size).toBe(0);
});

it('matches case-insensitively and with width/space tricks', () => {
  const m = (name: string) => ({ method: 'TOOLS/call', params: { name } });
  expect(isDeniedCall(m('ＺohoMail_sendEmail'), denied)).toBe(true);
  expect(isDeniedCall(m(' zohomail_SENDREPLYEMAIL'), denied)).toBe(true);
  expect(isDeniedCall(m('ZohoMail_listEmails'), denied)).toBe(false);
  expect(isDeniedCall({ method: 'tools/list' }, denied)).toBe(false);
});

it('parses singles and batches, rejects non-JSON', () => {
  expect(parseRpc('[{"id":1},{"id":2}]')?.batch).toBe(true);
  expect(parseRpc('{"id":1}')?.batch).toBe(false);
  expect(parseRpc('nope')).toBeNull();
  expect(parseRpc(undefined)).toBeNull();
  expect(isToolsList({ method: 'tools/list' })).toBe(true);
});

it('filters tools in JSON, batch and SSE bodies; leaves junk alone', () => {
  const r = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'ZohoMail_sendEmail' }, { name: 'a' }] } };
  expect(filterToolsResult(r, denied)).toEqual({ ...r, result: { tools: [{ name: 'a' }] } });
  expect(filterToolsResult([r], denied)).toEqual([{ ...r, result: { tools: [{ name: 'a' }] } }]);
  expect(filterToolsBody(`data: ${JSON.stringify(r)}\n\n`, 'text/event-stream', denied)).not.toContain('sendEmail');
  expect(filterToolsBody('not json', 'application/json', denied)).toBe('not json');
});
