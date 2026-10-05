/**
 * Tests for the CLI side of the shutdown marker.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearShutdownMarker, hasShutdownMarker, shutdownMarkerPath, stopLegacySupervisor } from './shutdown-marker.js';

describe('shutdown marker (cli)', () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-shutdown-marker-'));
	});
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('uses the same path as the backend and the supervisor script', () => {
		expect(shutdownMarkerPath(home)).toBe(path.join(home, 'run', 'shutdown-requested'));
	});

	it('sees and clears the marker', () => {
		fs.mkdirSync(path.join(home, 'run'));
		fs.writeFileSync(shutdownMarkerPath(home), '{}');
		expect(hasShutdownMarker(home)).toBe(true);
		clearShutdownMarker(home);
		expect(hasShutdownMarker(home)).toBe(false);
		clearShutdownMarker(home);
	});

	describe('stopLegacySupervisor', () => {
		it('stops an old crewly-start wrapper that is the parent', () => {
			const kill = jest.fn();
			expect(stopLegacySupervisor(4321, { commandOf: () => '/bin/bash /Users/me/.crewly/crewly-start.command', kill })).toBe(true);
			expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM');
		});

		it('leaves any other parent alone (shell, systemd, launchd, pm2)', () => {
			const kill = jest.fn();
			expect(stopLegacySupervisor(4321, { commandOf: () => '-zsh', kill })).toBe(false);
			expect(stopLegacySupervisor(1, { commandOf: () => 'crewly-start', kill })).toBe(false);
			expect(kill).not.toHaveBeenCalled();
		});

		it('never throws when the parent cannot be inspected', () => {
			expect(stopLegacySupervisor(4321, { commandOf: () => { throw new Error('no ps'); } })).toBe(false);
		});
	});
});
