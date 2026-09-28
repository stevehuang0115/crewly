/**
 * Tests for PtySessionBackend.getTerminalTitle (#815, moved out by #820).
 *
 * These tests were originally in pty-session-backend.test.ts, but that whole
 * file is in jest.config.js's `testPathIgnorePatterns` because most of its
 * tests spawn a real PTY (native node-pty binary), which this environment
 * cannot run. That made the whole file silently skipped, including these two
 * tests, which do NOT spawn a PTY at all — they construct a PtyTerminalBuffer
 * directly and inject it into the backend's private `terminalBuffers` map,
 * exactly the pattern the #815 PR's own commit message used elsewhere
 * ("test backend methods by injecting a PtyTerminalBuffer into the private
 * terminalBuffers map"). Splitting them into their own file lets them
 * actually run in `npm test` / CI, instead of only ever compiling.
 *
 * @module services/session/pty/pty-session-backend-terminal-title.test
 */

import { PtySessionBackend } from './pty-session-backend.js';
import { PtyTerminalBuffer } from './pty-terminal-buffer.js';

describe('PtySessionBackend.getTerminalTitle (#815)', () => {
	let backend: PtySessionBackend | null = null;

	beforeEach(() => {
		backend = new PtySessionBackend();
	});

	afterEach(async () => {
		if (backend) {
			await backend.destroy();
			backend = null;
		}
	});

	it('should return empty string for non-existent session', () => {
		expect(backend!.getTerminalTitle('non-existent')).toBe('');
	});

	it('should return the title held by the session\'s terminal buffer', async () => {
		// Real PTY output is not needed: the buffer's own test covers OSC
		// parsing; this checks the backend reads the per-session buffer.
		const buf = new PtyTerminalBuffer();
		buf.write('\x1b]0;crewly-title-probe\x07');
		await buf.flush();
		(backend as unknown as { terminalBuffers: Map<string, PtyTerminalBuffer> }).terminalBuffers.set('title-session', buf);
		expect(backend!.getTerminalTitle('title-session')).toBe('crewly-title-probe');
		buf.dispose();
	});
});
