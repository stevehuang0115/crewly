/**
 * Backup push, started from outside the machine.
 *
 * `crewly backup push` needs a terminal on the machine. The portal (and the
 * phone) reach an instance only over the relay, so the same thing is offered
 * here as a background job: start it, then poll its state. One job at a time —
 * an archive of CREWLY_HOME can take a while, and two at once would only
 * compete for the same disk and upload.
 *
 * @module services/backup/backup-push.service
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { BackupArchiveService } from './backup-archive.service.js';
import { BackupCloudClient, BackupNotProError } from './backup-cloud.client.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { CloudClientService } from '../cloud/cloud-client.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/** Where a push is. */
export interface BackupPushState {
  state: 'idle' | 'running' | 'done' | 'failed';
  /** What it is doing while running */
  step?: 'archiving' | 'uploading';
  startedAt?: string;
  finishedAt?: string;
  backupId?: string;
  sizeBytes?: number;
  /** Set when failed; `not_pro` and `not_connected` are the expected ones */
  error?: string;
  errorCode?: 'not_pro' | 'not_connected' | 'failed';
}

/** Collaborators, injectable for tests. */
export interface BackupPushDeps {
  archive: Pick<BackupArchiveService, 'createArchive'>;
  /** Cloud URL and token of the signed-in account, or null when signed out */
  cloudAuth: () => { baseUrl: string; token: string } | null;
  client: (auth: { baseUrl: string; token: string }) => Pick<BackupCloudClient, 'push'>;
  home: () => string;
  hostname: () => string;
  now: () => Date;
}

/** Runs one cloud backup at a time and remembers how the last one went. */
export class BackupPushService {
  private static instance: BackupPushService | null = null;
  private readonly logger: ComponentLogger;
  private current: BackupPushState = { state: 'idle' };

  constructor(private readonly deps: BackupPushDeps = defaultDeps()) {
    this.logger = LoggerService.getInstance().createComponentLogger('BackupPush');
  }

  /** @returns The process-wide instance */
  static getInstance(): BackupPushService {
    if (!BackupPushService.instance) BackupPushService.instance = new BackupPushService();
    return BackupPushService.instance;
  }

  /** Test affordance. */
  static resetInstance(): void {
    BackupPushService.instance = null;
  }

  /** @returns The running or last push */
  status(): BackupPushState {
    return { ...this.current };
  }

  /**
   * Start a push in the background.
   *
   * @param options - Leave chat.db out when false
   * @returns The new state, or null when one is already running
   */
  start(options: { chatDb?: boolean } = {}): BackupPushState | null {
    if (this.current.state === 'running') return null;
    this.current = { state: 'running', step: 'archiving', startedAt: this.deps.now().toISOString() };
    void this.run(options).catch(() => undefined);
    return this.status();
  }

  /**
   * The push itself: archive CREWLY_HOME, then upload it.
   *
   * @param options - Same as {@link start}
   */
  async run(options: { chatDb?: boolean } = {}): Promise<void> {
    const auth = this.deps.cloudAuth();
    if (!auth) {
      this.finish({ state: 'failed', errorCode: 'not_connected', error: 'This machine is not signed in to Crewly Cloud' });
      return;
    }
    const home = this.deps.home();
    const deviceName = this.deps.hostname();
    const deviceId = readDeviceId(home);
    let archivePath: string | null = null;
    try {
      const created = await this.deps.archive.createArchive({
        homePath: home,
        excludeChatDb: options.chatDb === false,
        createdAt: this.deps.now().toISOString(),
        sourceDeviceId: deviceId,
        sourceDeviceName: deviceName,
      });
      archivePath = created.archivePath;
      this.current = { ...this.current, step: 'uploading' };
      const item = await this.deps.client(auth).push(archivePath, { deviceName, deviceId: deviceId ?? undefined });
      this.finish({ state: 'done', backupId: item.backupId, sizeBytes: item.sizeBytes });
      this.logger.info('Workspace backup pushed to cloud', { backupId: item.backupId, sizeBytes: item.sizeBytes });
    } catch (err) {
      const notPro = err instanceof BackupNotProError;
      this.finish({
        state: 'failed',
        errorCode: notPro ? 'not_pro' : 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      this.logger.warn('Workspace backup push failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      // The local archive only existed to be uploaded.
      if (archivePath) await fs.promises.rm(archivePath, { force: true }).catch(() => undefined);
    }
  }

  private finish(patch: Omit<BackupPushState, 'startedAt'>): void {
    this.current = { startedAt: this.current.startedAt, ...patch, finishedAt: this.deps.now().toISOString() };
  }
}

/**
 * Best-effort source device id from CREWLY_HOME/device.json.
 *
 * @param home - CREWLY_HOME path
 * @returns Device id or null
 */
function readDeviceId(home: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'device.json'), 'utf8')) as { id?: string; deviceId?: string };
    return parsed.id ?? parsed.deviceId ?? null;
  } catch {
    return null;
  }
}

/** @returns Production collaborators */
function defaultDeps(): BackupPushDeps {
  return {
    archive: new BackupArchiveService(),
    cloudAuth: () => {
      const cloud = CloudClientService.getInstance();
      const baseUrl = cloud.getCloudUrl();
      const token = cloud.getToken();
      return baseUrl && token ? { baseUrl, token } : null;
    },
    client: (auth) => new BackupCloudClient(auth),
    home: () => getCrewlyHomePath(),
    hostname: () => os.hostname(),
    now: () => new Date(),
  };
}
