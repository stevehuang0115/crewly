/**
 * Tests for the remote MCP API client.
 *
 * @module services/remote-mcp.service.test
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addRemoteMcp, listRemoteMcp, removeRemoteMcp, renameRemoteMcp, testRemoteMcp } from './remote-mcp.service';

const fetchMock = vi.fn();

/**
 * A fetch response.
 *
 * @param body - JSON body
 * @param status - HTTP status
 * @returns Response-like object
 */
const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('remote-mcp.service', () => {
  it('lists, adds, renames, removes and tests against /api/connectors/remote-mcp', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, data: [{ id: 'zoho' }] }));
    expect(await listRemoteMcp()).toEqual([{ id: 'zoho' }]);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/connectors/remote-mcp');

    fetchMock.mockResolvedValueOnce(reply({ success: true, data: { id: 'zoho' }, note: 'next start' }, 201));
    expect(await addRemoteMcp({ label: 'Zoho', url: 'https://x', provider: 'zoho' })).toEqual({ server: { id: 'zoho' }, note: 'next start' });
    expect(fetchMock.mock.lastCall?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ label: 'Zoho', url: 'https://x', provider: 'zoho' }) });

    fetchMock.mockResolvedValueOnce(reply({ success: true, data: { id: 'zoho', label: 'Z' } }));
    expect(await renameRemoteMcp('zoho', 'Z')).toEqual({ id: 'zoho', label: 'Z' });
    expect(fetchMock.mock.lastCall?.[0]).toBe('/api/connectors/remote-mcp/zoho');

    fetchMock.mockResolvedValueOnce(reply({ success: true }));
    await removeRemoteMcp('zoho');
    expect(fetchMock.mock.lastCall?.[1]).toEqual({ method: 'DELETE' });

    fetchMock.mockResolvedValueOnce(reply({ success: true, data: { ok: true, toolCount: 1, tools: ['a'] } }));
    expect(await testRemoteMcp('zoho')).toEqual({ ok: true, toolCount: 1, tools: ['a'] });
    expect(fetchMock.mock.lastCall?.[0]).toBe('/api/connectors/remote-mcp/zoho/test');
  });

  it('throws the API message on failure', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: false, message: 'Paste the server URL.' }, 400));
    await expect(addRemoteMcp({ label: 'Z', url: '', provider: 'zoho' })).rejects.toThrow('Paste the server URL.');
  });
});
