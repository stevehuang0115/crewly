/**
 * Backup Cloud Client (P3)
 *
 * OSS-side HTTP client for the Pro-gated cloud backup service
 * (`/api/cloud/backup`). Used by `crewly backup push/pull/list` to park an
 * archive in the cloud and pull it back on another machine.
 *
 * Transport-only: it streams files to/from the cloud and surfaces a friendly
 * upgrade error on 402. Auth (access token) + base URL come from
 * CloudClientService; both are injected so this is testable without the cloud.
 *
 * @module services/backup/backup-cloud.client
 */

import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Thrown when the account isn't Pro (HTTP 402). */
export class BackupNotProError extends Error {
  readonly code = 'upgrade_required';
  constructor(message = 'Cloud backup requires a Pro plan. Upgrade at https://crewlyai.com/pricing.') {
    super(message);
    this.name = 'BackupNotProError';
  }
}

/** Thrown on any other cloud backup HTTP failure. */
export class BackupCloudError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BackupCloudError';
  }
}

/** A cloud snapshot as returned by the service (client-facing view). */
export interface CloudBackupItem {
  backupId: string;
  deviceName: string | null;
  deviceId: string | null;
  sizeBytes: number;
  sha256: string | null;
  cryptoMode: 'sse' | 'none';
  createdAt: string;
}

/** Metadata sent with an upload. */
export interface PushMeta {
  backupId?: string;
  deviceName?: string | null;
  deviceId?: string | null;
  sha256?: string | null;
}

/** HTTP client for the cloud backup endpoints. */
export class BackupCloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(suffix: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}/api/cloud/backup${suffix}`;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}`, ...extra };
  }

  /** List this account's cloud snapshots (newest first). */
  async list(): Promise<CloudBackupItem[]> {
    const res = await this.fetchImpl(this.url(''), { headers: this.authHeaders() });
    await this.assertOk(res);
    const json = (await res.json()) as { data?: { backups?: CloudBackupItem[] } };
    return json.data?.backups ?? [];
  }

  /**
   * Upload an archive to the cloud. Streams the file with its Content-Length so
   * the service can enforce quota before accepting the blob.
   *
   * @param archivePath - Local archive (.tar.gz)
   * @param meta - Optional backupId + device/sha metadata
   * @returns The created snapshot record
   */
  async push(archivePath: string, meta: PushMeta = {}): Promise<CloudBackupItem> {
    const stat = await fs.stat(archivePath);
    const query = meta.backupId ? `?backupId=${encodeURIComponent(meta.backupId)}` : '';
    const headers = this.authHeaders({
      'Content-Type': 'application/gzip',
      'Content-Length': String(stat.size),
      ...(meta.deviceName ? { 'X-Device-Name': meta.deviceName } : {}),
      ...(meta.deviceId ? { 'X-Device-Id': meta.deviceId } : {}),
      ...(meta.sha256 ? { 'X-Backup-Sha256': meta.sha256 } : {}),
    });
    const res = await this.fetchImpl(this.url(query), {
      method: 'POST',
      headers,
      body: createReadStream(archivePath) as unknown as RequestInit['body'],
      // Node fetch requires this for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await this.assertOk(res);
    const json = (await res.json()) as { data: CloudBackupItem };
    return json.data;
  }

  /**
   * Download a snapshot to `destPath` (streamed).
   *
   * @param backupId - Snapshot id
   * @param destPath - Local file to write
   */
  async pull(backupId: string, destPath: string): Promise<void> {
    const res = await this.fetchImpl(this.url(`/${encodeURIComponent(backupId)}`), { headers: this.authHeaders() });
    await this.assertOk(res);
    if (!res.body) throw new BackupCloudError('Empty download response from cloud.');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
  }

  /** Delete a cloud snapshot. */
  async remove(backupId: string): Promise<void> {
    const res = await this.fetchImpl(this.url(`/${encodeURIComponent(backupId)}`), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    await this.assertOk(res);
  }

  /** Map non-2xx responses to typed errors (402 → upgrade). */
  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    if (res.status === 402) {
      let msg: string | undefined;
      try {
        msg = ((await res.json()) as { error?: string }).error;
      } catch {
        /* ignore */
      }
      throw new BackupNotProError(msg);
    }
    let message = `Cloud backup request failed (HTTP ${res.status}).`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* non-JSON body */
    }
    throw new BackupCloudError(message, res.status);
  }
}
