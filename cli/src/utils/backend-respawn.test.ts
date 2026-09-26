/**
 * Tests for the restart-loop respawn decision.
 *
 * @module cli/utils/backend-respawn.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MARKER_RESPAWN_WINDOW_MS, resolveCrewlyHome, shouldRespawnBackend } from './backend-respawn.js';

describe('backend-respawn', () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-test-'));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	const writeMarker = (): number => {
		const file = path.join(home, 'auto-update-pending.json');
		fs.writeFileSync(file, '{}');
		return fs.statSync(file).mtimeMs;
	};

	it('respawns on RESTART_REQUESTED', () => {
		expect(shouldRespawnBackend(120, { crewlyHome: home })).toBe('restart-requested');
	});

	it('does not respawn on other exits without a marker', () => {
		expect(shouldRespawnBackend(0, { crewlyHome: home })).toBeNull();
		expect(shouldRespawnBackend(null, { crewlyHome: home })).toBeNull();
	});

	it('respawns once for a fresh auto-update marker (self-SIGKILL after the upgrade)', () => {
		const mtime = writeMarker();
		expect(shouldRespawnBackend(null, { crewlyHome: home, now: mtime + 1000 })).toBe('auto-update-marker');
		expect(shouldRespawnBackend(null, { crewlyHome: home, now: mtime + 1000, markerRespawnUsed: true })).toBeNull();
	});

	it('ignores a stale marker', () => {
		const mtime = writeMarker();
		expect(shouldRespawnBackend(1, { crewlyHome: home, now: mtime + MARKER_RESPAWN_WINDOW_MS + 1 })).toBeNull();
	});

	it('resolves the crewly home from CREWLY_HOME or the home dir', () => {
		expect(resolveCrewlyHome({ CREWLY_HOME: '/x/home' }, '/h')).toBe('/x/home');
		expect(resolveCrewlyHome({}, '/h')).toBe(path.join('/h', '.crewly'));
		expect(resolveCrewlyHome({ CREWLY_HOME: '' }, '/h')).toBe(path.join('/h', '.crewly'));
	});
});
