/**
 * Tests for BackupPushService — a cloud backup started from outside the machine.
 */

import { BackupPushService, type BackupPushDeps } from './backup-push.service.js';
import { BackupNotProError } from './backup-cloud.client.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

function deps(over: Partial<BackupPushDeps> = {}): BackupPushDeps {
  let t = 0;
  return {
    archive: { createArchive: jest.fn().mockResolvedValue({ archivePath: '/nonexistent/a.tar.gz', manifest: {} }) },
    cloudAuth: () => ({ baseUrl: 'https://cloud', token: 'jwt' }),
    client: () => ({ push: jest.fn().mockResolvedValue({ backupId: 'b-1', sizeBytes: 1234 }) }),
    home: () => '/home/x/.crewly',
    hostname: () => 'macbookpro.lan',
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, t++)),
    ...over,
  } as BackupPushDeps;
}

describe('BackupPushService', () => {
  it('archives, uploads and reports the backup id', async () => {
    const push = jest.fn().mockResolvedValue({ backupId: 'b-1', sizeBytes: 1234 });
    const svc = new BackupPushService(deps({ client: () => ({ push }) }));

    await svc.run();

    expect(svc.status()).toMatchObject({ state: 'done', backupId: 'b-1', sizeBytes: 1234 });
    expect(push).toHaveBeenCalledWith('/nonexistent/a.tar.gz', expect.objectContaining({ deviceName: 'macbookpro.lan' }));
  });

  it('runs one at a time', () => {
    const svc = new BackupPushService(deps({ archive: { createArchive: () => new Promise(() => undefined) } as never }));
    expect(svc.start()).toMatchObject({ state: 'running', step: 'archiving' });
    expect(svc.start()).toBeNull();
  });

  it('says plainly when the account is not Pro, or the machine is not signed in', async () => {
    const notPro = new BackupPushService(deps({ client: () => ({ push: jest.fn().mockRejectedValue(new BackupNotProError()) }) }));
    await notPro.run();
    expect(notPro.status()).toMatchObject({ state: 'failed', errorCode: 'not_pro' });

    const signedOut = new BackupPushService(deps({ cloudAuth: () => null }));
    await signedOut.run();
    expect(signedOut.status()).toMatchObject({ state: 'failed', errorCode: 'not_connected' });
  });

  it('can leave chat.db out', async () => {
    const createArchive = jest.fn().mockResolvedValue({ archivePath: '/nonexistent/a.tar.gz', manifest: {} });
    const svc = new BackupPushService(deps({ archive: { createArchive } }));
    await svc.run({ chatDb: false });
    expect(createArchive).toHaveBeenCalledWith(expect.objectContaining({ excludeChatDb: true }));
  });
});
