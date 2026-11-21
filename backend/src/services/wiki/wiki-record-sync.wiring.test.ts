import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WikiRecordSyncService } from './wiki-record-sync.service.js';
import { getWikiRecordSyncService, setWikiRecordSyncService, startRecordSync, stopRecordSync, syncRecords } from './wiki-record-sync.wiring.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

let home: string;
const previousHome = process.env.CREWLY_HOME;

/**
 * Create a wiki vault.
 *
 * @param root - Vault root
 */
const vault = (root: string): void => {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'SCHEMA.md'), '# schema\n');
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'crewly-sync-home-'));
	process.env.CREWLY_HOME = home;
});

afterEach(() => {
	stopRecordSync();
	setWikiRecordSyncService(null);
	if (previousHome === undefined) delete process.env.CREWLY_HOME;
	else process.env.CREWLY_HOME = previousHome;
	rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('syncRecords', () => {
	it('walks every team vault and the global vault, or the one named', async () => {
		vault(join(home, 'teams', 't1', 'wiki'));
		vault(join(home, 'global-wiki'));
		const service = { syncVaults: jest.fn(async () => []), syncVault: jest.fn(async (v: string) => ({ vaultPath: v, sources: 0, written: [], unchanged: 0, skipped: [], errors: [] })) };
		setWikiRecordSyncService(service as unknown as WikiRecordSyncService);

		await syncRecords();
		expect(service.syncVaults).toHaveBeenCalledWith([join(home, 'teams', 't1', 'wiki'), join(home, 'global-wiki')]);

		const [one] = await syncRecords(join(home, 'teams', 't1', 'wiki'));
		expect(one.vaultPath).toBe(join(home, 'teams', 't1', 'wiki'));
	});

	it('refuses a path that is not one of this machine\'s vaults', async () => {
		vault(join(home, 'global-wiki'));
		setWikiRecordSyncService({ syncVault: jest.fn(), syncVaults: jest.fn() } as unknown as WikiRecordSyncService);
		await expect(syncRecords('/etc')).rejects.toThrow('Not a team or global wiki vault');
	});
});

describe('getWikiRecordSyncService / startRecordSync', () => {
	it('returns one instance until replaced', () => {
		const first = getWikiRecordSyncService();
		expect(first).toBeInstanceOf(WikiRecordSyncService);
		expect(getWikiRecordSyncService()).toBe(first);
	});

	it('runs shortly after start and then on the interval; starting twice adds nothing', () => {
		jest.useFakeTimers();
		try {
			const service = { syncVaults: jest.fn(async () => []), syncVault: jest.fn() };
			setWikiRecordSyncService(service as unknown as WikiRecordSyncService);
			startRecordSync();
			startRecordSync();
			expect(service.syncVaults).not.toHaveBeenCalled();
			jest.advanceTimersByTime(5 * 60_000);
			expect(service.syncVaults).toHaveBeenCalledTimes(1);
			jest.advanceTimersByTime(6 * 60 * 60_000);
			expect(service.syncVaults).toHaveBeenCalledTimes(2);
			stopRecordSync();
			jest.advanceTimersByTime(12 * 60 * 60_000);
			expect(service.syncVaults).toHaveBeenCalledTimes(2);
		} finally {
			jest.useRealTimers();
		}
	});
});
