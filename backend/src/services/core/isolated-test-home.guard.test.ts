/**
 * Guard: tests never write into the real ~/.crewly.
 *
 * Runs the real writers of the files whose leaks have hurt the owner —
 * device.json, api-token, cloud/config.json (a fake session killed relay
 * and Slack delivery, 2026-09-24) and cloud/relay-queue.json (a random
 * queue id cost half an hour of Slack, 2026-10-02) — with CREWLY_HOME set
 * and with it removed (the `os.homedir()` fallback), then checks that every
 * file landed in the per-test-file temp home and that nothing reached the
 * real home:
 * - device.json and api-token: mtime unchanged (a running Crewly never
 *   rewrites them);
 * - all four: none of the values this test wrote appear there. (A running
 *   Crewly legitimately rewrites cloud/config.json on token refresh and may
 *   rewrite relay-queue.json, so an mtime check alone would flake.)
 *
 * The real home comes from `os.userInfo()` (the passwd entry), which the
 * jest setup does not patch — so this test still knows where the real home
 * is if the setup is ever removed, and refuses to write when not isolated.
 *
 * @see tests/setup.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceIdentityService } from '../cloud/device-identity.service.js';
import { CloudClientService } from '../cloud/cloud-client.service.js';
import { CloudSyncService } from '../cloud/cloud-sync.service.js';
import { resetApiTokenCache, resolveApiToken } from './api-token.service.js';
import { getCrewlyHomePath } from './crewly-home.utils.js';

const REAL_HOME = os.userInfo().homedir;
const GUARDED = ['device.json', 'api-token', path.join('cloud', 'config.json'), path.join('cloud', 'relay-queue.json')];
/** Files a running Crewly never rewrites — their mtime must not move. */
const STABLE = new Set(['device.json', 'api-token']);
const realFile = (rel: string): string => path.join(REAL_HOME, '.crewly', rel);

/** Marker values this test writes (cloud config / queue id are fixed; device id and token are captured). */
const markers: string[] = ['guard-test-token', 'https://cloud.invalid', 'q-guard-test'];

/** mtime (ms) of each guarded real file, null when it does not exist. */
function realMtimes(): Map<string, number | null> {
	return new Map(
		GUARDED.map((rel) => {
			try {
				return [rel, fs.statSync(realFile(rel)).mtimeMs];
			} catch {
				return [rel, null];
			}
		}),
	);
}

/** Whether this file runs against a temp home (else nothing may be written). */
function isIsolated(): boolean {
	const realCrewly = path.resolve(REAL_HOME, '.crewly');
	const crewlyHome = path.resolve(getCrewlyHomePath());
	return (
		path.resolve(os.homedir()) !== path.resolve(REAL_HOME) &&
		crewlyHome !== realCrewly &&
		!crewlyHome.startsWith(realCrewly + path.sep)
	);
}

/**
 * Write all four guarded files through the production code paths.
 *
 * @returns Where each writer put its file
 */
async function writeGuardedFiles(): Promise<string[]> {
	DeviceIdentityService.resetInstance();
	const identity = await new DeviceIdentityService().getOrCreateIdentity();
	markers.push(identity.deviceId);

	delete process.env['CREWLY_API_TOKEN'];
	resetApiTokenCache();
	const token = resolveApiToken();
	markers.push(token.token);
	resetApiTokenCache();

	CloudClientService.resetInstance();
	const client = CloudClientService.getInstance() as unknown as {
		cloudUrl: string | null;
		token: string | null;
		persistConfig: () => Promise<void>;
	};
	client.cloudUrl = 'https://cloud.invalid';
	client.token = 'guard-test-token';
	await client.persistConfig();
	CloudClientService.resetInstance();

	CloudSyncService.resetInstance();
	const sync = CloudSyncService.getInstance() as unknown as {
		generation: number;
		writeFallbackQueueId: (queueId: string, gen: number) => Promise<void>;
		fallbackQueueFile: () => string;
	};
	await sync.writeFallbackQueueId('q-guard-test', sync.generation);
	const queueFile = sync.fallbackQueueFile();
	CloudSyncService.resetInstance();

	return [
		path.join(os.homedir(), '.crewly', 'device.json'),
		token.filePath,
		CloudClientService.getConfigPath(),
		queueFile,
	];
}

describe('isolated test home (jest setup)', () => {
	const before = realMtimes();
	const savedCrewlyHome = process.env['CREWLY_HOME'];

	afterEach(() => {
		process.env['CREWLY_HOME'] = savedCrewlyHome;
	});

	it('points os.homedir(), HOME and CREWLY_HOME at a per-file temp dir', () => {
		expect(os.homedir()).not.toBe(REAL_HOME);
		expect(process.env['HOME']).toBe(os.homedir());
		expect(process.env['CREWLY_HOME']).toBe(path.join(os.homedir(), '.crewly'));
	});

	it.each([
		['CREWLY_HOME set', true],
		['CREWLY_HOME removed (os.homedir() fallback)', false],
	])('device.json, api-token, cloud/config.json and relay-queue.json land in the temp home — %s', async (_label, keepCrewlyHome) => {
		if (!keepCrewlyHome) delete process.env['CREWLY_HOME'];
		// Never write when not isolated: that would be the very leak this guards.
		if (!isIsolated()) throw new Error(`Test home is not isolated (homedir=${os.homedir()}); refusing to write`);

		const written = await writeGuardedFiles();

		const tempCrewlyHome = path.join(os.homedir(), '.crewly');
		expect(written.map((f) => path.relative(tempCrewlyHome, f))).toEqual(GUARDED);
		for (const file of written) expect(fs.existsSync(file)).toBe(true);
	});

	it("leaves the real home's files untouched", () => {
		const after = realMtimes();
		for (const rel of GUARDED) {
			// No file appears that was not there before.
			if (before.get(rel) === null) expect([rel, after.get(rel)]).toEqual([rel, null]);
			if (STABLE.has(rel)) expect([rel, after.get(rel)]).toEqual([rel, before.get(rel)]);
			if (after.get(rel) === null) continue;
			const content = fs.readFileSync(realFile(rel), 'utf-8');
			for (const marker of markers) expect([rel, content.includes(marker)]).toEqual([rel, false]);
		}
	});
});
