/**
 * Tests for BackupCloudClient (P3) — uses an injected fetch returning real
 * Response objects (no network).
 */

import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackupCloudClient, BackupNotProError, BackupCloudError } from './backup-cloud.client.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bcc-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function client(fetchImpl: typeof fetch): BackupCloudClient {
  return new BackupCloudClient({ baseUrl: 'https://api.crewlyai.com', token: 'tok-123', fetchImpl });
}

describe('BackupCloudClient', () => {
  it('list() returns snapshots and sends the bearer token', async () => {
    let seenAuth: string | undefined;
    let seenUrl: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ success: true, data: { backups: [{ backupId: 'b1' }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const items = await client(fetchImpl).list();
    expect(items).toEqual([{ backupId: 'b1' }]);
    expect(seenUrl).toBe('https://api.crewlyai.com/api/cloud/backup');
    expect(seenAuth).toBe('Bearer tok-123');
  });

  it('push() streams the file with Content-Length + device headers', async () => {
    const file = path.join(dir, 'wb.tar.gz');
    await fs.writeFile(file, Buffer.alloc(1234, 7));
    let init: (RequestInit & { duplex?: string }) | undefined;
    const fetchImpl = (async (_url: string, i?: RequestInit) => {
      init = i as RequestInit & { duplex?: string };
      return new Response(JSON.stringify({ success: true, data: { backupId: 'b9', sizeBytes: 1234 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await client(fetchImpl).push(file, { backupId: 'b9', deviceName: 'mac.lan', sha256: 'abc' });
    expect(res.backupId).toBe('b9');
    expect(init?.method).toBe('POST');
    const h = init?.headers as Record<string, string>;
    expect(h['Content-Length']).toBe('1234');
    expect(h['X-Device-Name']).toBe('mac.lan');
    expect(h['X-Backup-Sha256']).toBe('abc');
    expect(init?.duplex).toBe('half');
    expect(init?.body).toBeTruthy();
  });

  it('pull() streams the response body to a file', async () => {
    const payload = Buffer.from('archive-bytes-here');
    const fetchImpl = (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch;
    const dest = path.join(dir, 'down', 'wb.tar.gz');
    await client(fetchImpl).pull('b1', dest);
    expect(readFileSync(dest).equals(payload)).toBe(true);
  });

  it('remove() issues a DELETE', async () => {
    let method: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      method = init?.method;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await client(fetchImpl).remove('b1');
    expect(method).toBe('DELETE');
  });

  it('maps 402 to BackupNotProError', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Cloud backup requires a Pro plan.' }), { status: 402 })) as unknown as typeof fetch;
    await expect(client(fetchImpl).list()).rejects.toBeInstanceOf(BackupNotProError);
  });

  it('maps other failures to BackupCloudError with the server message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Backup not found.' }), { status: 404 })) as unknown as typeof fetch;
    await expect(client(fetchImpl).remove('missing')).rejects.toThrow(/Backup not found/);
    await expect(client(fetchImpl).remove('missing')).rejects.toBeInstanceOf(BackupCloudError);
  });
});
