/**
 * Tests for the shutdown marker file.
 *
 * @module services/system/shutdown-marker.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearShutdownMarker, hasShutdownMarker, shutdownMarkerPath, writeShutdownMarker } from './shutdown-marker.js';

describe('shutdown marker', () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-marker-test-'));
	});
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('lives at <home>/run/shutdown-requested', () => {
		expect(shutdownMarkerPath(home)).toBe(path.join(home, 'run', 'shutdown-requested'));
	});

	it('is written with who and when, and cleared again', () => {
		expect(hasShutdownMarker(home)).toBe(false);
		writeShutdownMarker(home, 4242, () => Date.parse('2026-10-05T10:00:00Z'));
		expect(hasShutdownMarker(home)).toBe(true);
		expect(JSON.parse(fs.readFileSync(shutdownMarkerPath(home), 'utf-8'))).toEqual({ requestedAt: '2026-10-05T10:00:00.000Z', pid: 4242 });
		clearShutdownMarker(home);
		expect(hasShutdownMarker(home)).toBe(false);
		clearShutdownMarker(home); // absent is fine
	});
});
