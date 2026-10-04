/**
 * Tests for SessionCommandHelper
 */

import { SessionCommandHelper, KEY_CODES, createSessionCommandHelper } from './session-command-helper.js';
import type { ISession, ISessionBackend } from './session-backend.interface.js';
import { LoggerService } from '../core/logger.service.js';
import * as fs from 'fs';
import * as path from 'path';
import { PtyTerminalBuffer } from './pty/pty-terminal-buffer.js';
import { TUI_INPUT_GUARD } from '../../constants.js';
import { noteHarnessPaste, noteOutsideInput, noteShownMarker } from './input-ledger.js';

// Mock the logger service
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock PtyActivityTrackerService — default to high idle time (agent not busy)
const mockGetIdleTimeMs = jest.fn().mockReturnValue(999999);
const mockGetRawOutputIdleMs = jest.fn().mockReturnValue(null);
jest.mock('../agent/pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: jest.fn().mockReturnValue({
			getIdleTimeMs: (...args: unknown[]) => mockGetIdleTimeMs(...args),
			getRawOutputIdleMs: (...args: unknown[]) => mockGetRawOutputIdleMs(...args),
		}),
	},
}));

describe('SessionCommandHelper', () => {
	let mockBackend: jest.Mocked<ISessionBackend>;
	let mockSession: jest.Mocked<ISession>;
	let helper: SessionCommandHelper;

	beforeEach(() => {
		// Reset idle time mock to default (agent not busy)
		mockGetIdleTimeMs.mockReturnValue(999999);

		// Create mock session
		mockSession = {
			name: 'test-session',
			pid: 12345,
			cwd: '/test/path',
			onData: jest.fn(),
			onExit: jest.fn(),
			write: jest.fn(),
			resize: jest.fn(),
			kill: jest.fn(),
		} as any;

		// Create mock backend
		mockBackend = {
			createSession: jest.fn().mockResolvedValue(mockSession),
			getSession: jest.fn().mockReturnValue(mockSession),
			killSession: jest.fn().mockResolvedValue(undefined),
			listSessions: jest.fn().mockReturnValue(['test-session']),
			sessionExists: jest.fn().mockReturnValue(true),
			captureOutput: jest.fn().mockReturnValue('terminal output'),
			getTerminalBuffer: jest.fn().mockReturnValue('buffer content'),
			getRawHistory: jest.fn().mockReturnValue('raw history with \x1b[32mcolors\x1b[0m'),
			destroy: jest.fn().mockResolvedValue(undefined),
		} as any;

		helper = new SessionCommandHelper(mockBackend);
		// The paste watcher is driven by hand here (watchOwnPastes).
		SessionCommandHelper.autoWatch = false;
		SessionCommandHelper.pasteRenderMaxWaitMs = 0;
		SessionCommandHelper.repaintSampleMs = 1;
		mockGetRawOutputIdleMs.mockReturnValue(null);
		SessionCommandHelper.resetOwnPasteMarkersForTesting();
	});

	afterEach(() => {
		SessionCommandHelper.resetOwnPasteMarkersForTesting();
		jest.clearAllMocks();
	});

	describe('sessionExists', () => {
		it('should return true when session exists', () => {
			expect(helper.sessionExists('test-session')).toBe(true);
			expect(mockBackend.sessionExists).toHaveBeenCalledWith('test-session');
		});

		it('should return false when session does not exist', () => {
			mockBackend.sessionExists.mockReturnValue(false);
			expect(helper.sessionExists('non-existent')).toBe(false);
		});
	});

	describe('getSession', () => {
		it('should return session when it exists', () => {
			const session = helper.getSession('test-session');
			expect(session).toBe(mockSession);
		});

		it('should return undefined when session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			const session = helper.getSession('non-existent');
			expect(session).toBeUndefined();
		});
	});

	describe('sendMessage', () => {
		it('refuses to type when the input box cannot be read (no styled capture): nothing written', async () => {
			await expect(helper.sendMessage('test-session', 'hello world')).rejects.toMatchObject({ name: 'TuiInputGuardError' });
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('sendShellLine: bracketed paste followed by a separate Enter key (#292, #293)', async () => {
			await helper.sendShellLine('test-session', 'hello world');
			// First call: message text wrapped in bracketed paste markers
			expect(mockSession.write).toHaveBeenNthCalledWith(1, '\x1b[200~hello world\x1b[201~');
			// Second call: Enter key (after delay)
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
			expect(mockSession.write).toHaveBeenCalledTimes(2);
		});

		it('sendShellLine: multi-line text in one bracketed paste', async () => {
			await helper.sendShellLine('test-session', 'line1\nline2\nline3');
			expect(mockSession.write).toHaveBeenNthCalledWith(1, '\x1b[200~line1\nline2\nline3\x1b[201~');
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendMessage('non-existent', 'test')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendMessage input guard (2026-10-03 phantom owner input), on real TUI captures', () => {
		const FIX = path.join(__dirname, '__fixtures__', 'tui');
		const views = new Map<string, { lines: string[]; cursorRow: number }>();

		/**
		 * Load a recorded frame (Claude Code 2.1.288 / Codex 0.160.0) as the
		 * view the PTY backend would return.
		 */
		async function load(runtime: string, name: string): Promise<{ lines: string[]; cursorRow: number }> {
			const key = `${runtime}/${name}`;
			const cached = views.get(key);
			if (cached) return cached;
			const buffer = new PtyTerminalBuffer(100, 30);
			buffer.write(fs.readFileSync(path.join(FIX, runtime, `${name}.ansi`), 'utf8'));
			await buffer.flush();
			const view = buffer.getInputView();
			buffer.dispose();
			views.set(key, view);
			return view;
		}
		const cc = (n: string) => load('claude-code-2.1.288', n);
		const cx = (n: string) => load('codex-0.160.0', n);
		const gm = (n: string) => load('gemini-0.40.1', n);

		/**
		 * Script the screen: `atStart` until the first write, then each write
		 * of the given kind advances to the next frame (the last repeats).
		 */
		function script(frames: Array<{ lines: string[]; cursorRow: number } | null>, advanceOn: (data: string) => boolean = () => true) {
			let i = 0;
			mockSession.write.mockImplementation((data: string) => {
				if (advanceOn(data) && i < frames.length - 1) i++;
			});
			(mockBackend as any).captureInputView = jest.fn(() => frames[i]);
		}
		const writes = () => mockSession.write.mock.calls.map((c) => c[0] as string);
		const PASTE = (m: string) => `\x1b[200~${m}\x1b[201~`;
		const OURS = '[CHAT:c1] reminder: the owner is waiting';
		const TASK = '## Task\n\nPlease reply.\n> ok go\nthanks';

		it('Claude Code: empty box (placeholder) → paste → exactly ours → one Enter', async () => {
			script([await cc('empty-placeholder'), await cc('typed-single')]);
			await helper.sendMessage('test-session', 'hello world probe');
			expect(writes()).toEqual([PASTE('hello world probe'), '\r']);
		});

		it('Claude Code: the incident — an accepted suggestion in the box: nothing typed, nothing cleared, no Enter', async () => {
			script([await cc('accepted-suggestion')]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ name: 'TuiInputGuardError', stage: 'before-write' });
			expect(writes()).toEqual([]);
		});

		it('Claude Code: suggestion + our text in the box after paste → no Enter and the box is NOT cleared', async () => {
			script([await cc('empty-placeholder'), await cc('accepted-suggestion-plus-ours')]);
			await expect(helper.sendMessage('test-session', OURS)).rejects.toMatchObject({ name: 'TuiInputGuardError', stage: 'before-submit' });
			expect(writes()).toEqual([PASTE(OURS)]);
		});

		it('Claude Code: short quoted and multi-line messages are delivered', async () => {
			script([await cc('empty-placeholder'), await cc('pasted-quote-line')]);
			await helper.sendMessage('test-session', '> ok go');
			expect(writes()).toEqual([PASTE('> ok go'), '\r']);
			mockSession.write.mockReset();
			script([await cc('empty-placeholder'), await cc('pasted-5-lines-marker')]);
			await helper.sendMessage('test-session', TASK);
			expect(writes()).toEqual([PASTE(TASK), '\r']);
		});

		it('Codex: a multi-line "## Task" message with a quoted line is delivered', async () => {
			script([await cx('empty-placeholder'), await cx('pasted-5-lines')]);
			await helper.sendMessage('test-session', TASK);
			expect(writes()).toEqual([PASTE(TASK), '\r']);
		});

		it('Codex: our own leftover copy of the message is cleared with Ctrl+U + Backspace pairs, then sent', async () => {
			const frames = [await cx('pasted-5-lines'), await cx('pair-1'), await cx('pair-1'), await cx('pair-4'), await cx('pair-4'), await cx('pair-5'), await cx('pasted-5-lines')];
			// Advance one frame per pair (on the Backspace) and on the paste.
			script(frames, (d) => d === '\x7f' || d.startsWith('\x1b[200~'));
			await helper.sendMessage('test-session', TASK);
			const w = writes();
			expect(w.filter((x) => x === '\x15')).toHaveLength(5);
			expect(w.filter((x) => x === '\x7f')).toHaveLength(5);
			expect(w.slice(-2)).toEqual([PASTE(TASK), '\r']);
		});

		it('Gemini 0.40.1: delivered into the ▄▄▄/▀▀▀ box', async () => {
			script([await gm('empty-placeholder'), await gm('pasted-5-lines')]);
			await helper.sendMessage('test-session', TASK);
			expect(writes()).toEqual([PASTE(TASK), '\r']);
		});

		it('someone\'s half-typed text is never cleared — nothing typed (Codex race from the review)', async () => {
			script([await cx('typed-single')]);
			await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-write' });
			expect(writes()).toEqual([]);
		});

		it('text that rendered only after we read the box empty is left alone: no Enter, no clearing', async () => {
			script([await cx('empty-placeholder'), await cx('after-turn-pasted-5-lines')]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-submit' });
			expect(writes()).toEqual([PASTE('hello world probe')]);
		});

		it('an unreadable box: nothing typed, no Enter (the API-key dialog / Gemini /ide cases from the review)', async () => {
			script([{ lines: ['│ Paste your API key here │'], cursorRow: 0 }]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-write' });
			expect(writes()).toEqual([]);
		});

		it('a box that becomes unreadable after the paste: no Enter', async () => {
			script([await cc('empty-placeholder'), null]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-submit' });
			expect(writes()).not.toContain('\r');
		});

		it('never presses Enter when the paste did not land (box still empty)', async () => {
			script([await cc('empty-placeholder')]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-submit' });
			expect(writes()).not.toContain('\r');
		});

		it('sendShellLine types a command into a plain shell (paste + Enter) without reading a box', async () => {
			script([{ lines: ['user@host ~ % '], cursorRow: 0 }]);
			await helper.sendShellLine('test-session', 'claude --settings x');
			expect(writes()).toEqual([PASTE('claude --settings x'), '\r']);
		});

		/** A Claude Code view with the marker's paste counter changed (an owner paste later in the session). */
		function withCounter(view: { lines: string[]; cursorRow: number }, n: number) {
			return { ...view, lines: view.lines.map((l) => l.replace(/\[Pasted text #\d+/, `[Pasted text #${n}`)) };
		}
		/** A view whose input box holds our marker followed by another paste. */
		function withExtraPaste(view: { lines: string[]; cursorRow: number }) {
			return { ...view, lines: view.lines.map((l) => l.replace(/(\[Pasted text #\d+ \+\d+ lines\])/, '$1[Pasted text #5 +4 lines]')) };
		}

		describe('own paste record (crewly 1.20.200 Ella: a paste into a busy box rendered late and blocked it)', () => {
			// Plain screens as captureOutput gives them: a live turn repaints its
			// spinner counter on every read; an idle screen does not change.
			let tick = 0;
			const RULE = '─'.repeat(80);
			const busyScreen = () => [`✳ Ideating… (4m ${tick++}s · ↓ 3.1k tokens)`, '', `${'─'.repeat(64)} crewly-ella ─`, '❯ ', RULE, '  ⏵⏵ bypass permissions on · esc to interrupt'].join('\n');
			const IDLE_SCREEN = ['⏺ Understood… esc to interrupt is the busy bar.', '✻ Worked for 17s · done', '', `${'─'.repeat(64)} crewly-ella ─`, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
			let t = 1_000_000;
			let screen: { lines: string[]; cursorRow: number } | null = null;
			let busy = false;
			/** Drive the box by hand: `screen` is what the box shows; `busy` puts the busy bar on screen. */
			function manual() {
				(mockBackend as any).captureInputView = jest.fn(() => screen);
				mockBackend.captureOutput.mockImplementation(() => (busy ? busyScreen() : IDLE_SCREEN));
				mockGetIdleTimeMs.mockImplementation(() => (busy ? 50 : 999999));
			}
			const enters = () => writes().filter((w) => w === '\r').length;
			const pastes = () => writes().filter((w) => w.startsWith('\x1b[200~')).length;
			/** Five watcher passes per minute of `minutes`, the clock moving with them. */
			async function watchFor(minutes: number): Promise<void> {
				for (let i = 0; i < minutes * 12; i++) {
					t += 5_000;
					await SessionCommandHelper.watchOwnPastes();
				}
			}
			beforeEach(() => {
				SessionCommandHelper.resetOwnPasteMarkersForTesting();
				t = 1_000_000;
				SessionCommandHelper.now = () => t;
				SessionCommandHelper.pasteRenderMaxWaitMs = 0;
				busy = false;
				manual();
			});
			afterEach(() => {
				SessionCommandHelper.now = Date.now;
				SessionCommandHelper.pasteRenderMaxWaitMs = TUI_INPUT_GUARD.PASTE_RENDER_MAX_WAIT_MS;
				SessionCommandHelper.resetOwnPasteMarkersForTesting();
				mockGetIdleTimeMs.mockReset();
				mockGetIdleTimeMs.mockReturnValue(999999);
			});

			it('the incident: a startup-restore paste into a busy box renders late; 5 min later the agent is idle and it is submitted exactly once', async () => {
				busy = true;
				screen = await cc('busy-labelled-empty');
				// Startup restore / restart note: a plain sendMessage. The paste
				// has not rendered when we look → no Enter, refused.
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				expect(pastes()).toBe(1);
				expect(enters()).toBe(0);
				// It renders a moment later, while she is still busy.
				screen = await cc('busy-labelled-pasted-marker');
				await watchFor(5); // busy all along: no Enter, the record stays
				expect(enters()).toBe(0);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(true);
				// Every delivery meanwhile sees it as ours, not "someone else's text".
				expect(helper.readInputBox('test-session', 'another message', 'before-write')).toMatchObject({ state: 'ours', ownPasteMarker: true });
				// Idle: one Enter; the box empties.
				busy = false;
				mockSession.write.mockImplementation((d: string) => {
					if (d === '\r') screen = cc_empty;
				});
				await watchFor(1);
				expect(enters()).toBe(1);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
				await watchFor(5);
				expect(enters()).toBe(1);
				expect(pastes()).toBe(1);
			});
			let cc_empty: { lines: string[]; cursorRow: number };
			beforeAll(async () => {
				cc_empty = await load('claude-code-2.1.288', 'labelled-rule-empty');
			});

			it('a paste that renders a few seconds late in a busy box still gets its Enter (render wait)', async () => {
				SessionCommandHelper.now = Date.now;
				SessionCommandHelper.pasteRenderMaxWaitMs = 4_000;
				busy = true;
				screen = await cc('busy-labelled-empty');
				const marker = await cc('busy-labelled-pasted-marker');
				mockSession.write.mockImplementation((d: string) => {
					if (d.startsWith('\x1b[200~')) setTimeout(() => { screen = marker; }, 2_500);
				});
				await helper.sendMessage('test-session', TASK);
				expect(writes()).toEqual([PASTE(TASK), '\r']);
			});

			it('the next delivery of the same message submits the late paste instead of pasting it again', async () => {
				screen = await cc('labelled-rule-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('labelled-rule-pasted-marker');
				mockSession.write.mockImplementation((d: string) => {
					if (d === '\r') screen = cc_empty;
				});
				await helper.sendMessage('test-session', TASK);
				expect(pastes()).toBe(1);
				expect(enters()).toBe(1);
			});

			it('a different next message submits our late paste first, then is held — never pasted on top (1.20.207 02:12)', async () => {
				screen = await cc('labelled-rule-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('labelled-rule-pasted-marker');
				mockSession.write.mockImplementation((d: string) => {
					if (d === '\r') screen = cc_empty;
				});
				await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ name: 'TuiPasteHoldError', reason: 'just-submitted' });
				expect(writes().slice(1)).toEqual(['\r']);
				// Next try (the queue's retry): the box is settled, it goes in.
				const typed = await cc('typed-single');
				mockSession.write.mockImplementation((d: string) => {
					if (d.startsWith('\x1b[200~')) screen = typed;
				});
				await helper.sendMessage('test-session', 'hello world probe');
				expect(writes().slice(1)).toEqual(['\r', PASTE('hello world probe'), '\r']);
			});

			it('an owner paste of the same shape while ours sits in the box is never submitted (ours + theirs in the box)', async () => {
				busy = true;
				screen = await cc('busy-labelled-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('busy-labelled-pasted-marker');
				await watchFor(1);
				noteOutsideInput('test-session'); // the owner pastes through the terminal gateway
				screen = withExtraPaste(await cc('busy-labelled-pasted-marker'));
				await watchFor(1);
				busy = false;
				await watchFor(5);
				expect(enters()).toBe(0);
				expect(helper.readInputBox('test-session', 'x', 'before-write').state).toBe('foreign');
			});

			it('an owner who clears ours and pastes the same shape is never submitted (the counter differs)', async () => {
				busy = true;
				screen = await cc('busy-labelled-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('busy-labelled-pasted-marker'); // ours: #2
				await watchFor(1);
				noteOutsideInput('test-session'); // the owner clears ours and pastes, through the gateway
				screen = withCounter(await cc('busy-labelled-pasted-marker'), 3); // the owner's: #3
				busy = false;
				await watchFor(5);
				expect(enters()).toBe(0);
			});

			it('an owner paste of another shape while ours is pending is never adopted', async () => {
				screen = await cc('labelled-rule-empty');
				await expect(helper.sendMessage('test-session', 'one line only')).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('labelled-rule-pasted-marker'); // "+4 lines": not the shape of a one-line paste
				await watchFor(2);
				expect(enters()).toBe(0);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
			});

			it('a pending record is given up after OWN_PASTE_PENDING_MAX_MS; the ledger still knows the paste was ours (no outside input)', async () => {
				screen = await cc('labelled-rule-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				t += TUI_INPUT_GUARD.OWN_PASTE_PENDING_MAX_MS + 1;
				screen = await cc('labelled-rule-pasted-marker');
				expect(helper.readInputBox('test-session', TASK, 'recovery')).toMatchObject({ ownPasteMarker: true, ownPasteMessages: [TASK] });
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
				// With outside input since, the same marker could be anyone's.
				noteOutsideInput('test-session');
				expect(helper.readInputBox('test-session', TASK, 'recovery').ownPasteMarker).toBeFalsy();
			});

			describe('1.20.207 Ella: a second paste on a late-rendering first one; owner input via the gateway', () => {
				const A = ['A-MARK one', 'two', 'three', 'four', 'five'].join('\n');
				const B = ['B-MARK one', 'two', 'three', 'four', 'five'].join('\n');
				/** The box holding two of our markers run together: "[Pasted text #2 +4 lines][Pasted text #3 +4 lines]". */
				async function twoMarkers() {
					const v = await cc('busy-labelled-pasted-marker');
					return { ...v, lines: v.lines.map((l) => l.replace(/(\[Pasted text #2 \+4 lines\])/, '$1[Pasted text #3 +4 lines]')) };
				}

				it('the 02:12 sequence: B is held (not pasted) while A may still render; A renders and is submitted once idle; then B goes in', async () => {
					busy = true;
					screen = await cc('busy-labelled-empty');
					await expect(helper.sendMessage('test-session', A)).rejects.toMatchObject({ stage: 'before-submit' }); // A renders late
					// B arrives while A is pending: not pasted on top.
					await expect(helper.sendMessage('test-session', B)).rejects.toMatchObject({ name: 'TuiPasteHoldError', reason: 'pending-paste' });
					expect(pastes()).toBe(1);
					// A renders; B still held while it sits there.
					screen = await cc('busy-labelled-pasted-marker');
					await watchFor(1);
					expect(enters()).toBe(0);
					// Idle: A submitted once; its queued copy (if any) is dropped.
					const submitted: string[][] = [];
					SessionCommandHelper.onOwnPasteSubmitted = (_s, m) => submitted.push(m);
					busy = false;
					mockSession.write.mockImplementation((d: string) => {
						if (d === '\r') screen = cc_empty;
						else if (d.startsWith('\x1b[200~')) screen = twoAfterB;
					});
					const twoAfterB = await cc('labelled-rule-pasted-marker');
					await watchFor(1);
					expect(enters()).toBe(1);
					expect(submitted).toEqual([[A]]);
					// B now goes in normally: one paste, one Enter.
					await helper.sendMessage('test-session', B);
					expect(pastes()).toBe(2);
					expect(enters()).toBe(2);
					SessionCommandHelper.onOwnPasteSubmitted = null;
				});

				it('a delivery of the same pending message waits for it and submits it — never a second paste', async () => {
					screen = await cc('labelled-rule-empty');
					await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
					const marker = await cc('labelled-rule-pasted-marker');
					setTimeout(() => { screen = marker; }, 30); // renders while the retry waits
					mockSession.write.mockImplementation((d: string) => {
						if (d === '\r') screen = cc_empty;
					});
					await helper.sendMessage('test-session', TASK);
					expect(pastes()).toBe(1);
					expect(enters()).toBe(1);
				});

				it('two of our pastes run together in the box are ours: submitted once when idle (the 9-hour box)', async () => {
					noteHarnessPaste('test-session', A, t);
					noteHarnessPaste('test-session', B, t);
					screen = await twoMarkers();
					expect(helper.readInputBox('test-session', 'x', 'before-write')).toMatchObject({ state: 'ours', ownPasteMarker: true, ownPasteMessages: [A, B] });
					const submitted: string[][] = [];
					SessionCommandHelper.onOwnPasteSubmitted = (_s, m) => submitted.push(m);
					mockSession.write.mockImplementation((d: string) => {
						if (d === '\r') screen = cc_empty;
					});
					await watchFor(1);
					expect(enters()).toBe(1);
					expect(submitted).toEqual([[A, B]]);
					await watchFor(5);
					expect(enters()).toBe(1);
					SessionCommandHelper.onOwnPasteSubmitted = null;
				});

				it('the same box after outside input (the owner typed into the terminal) is not ours — unless every marker is one we saw', async () => {
					noteHarnessPaste('test-session', A, t);
					noteHarnessPaste('test-session', B, t);
					noteOutsideInput('test-session');
					screen = await twoMarkers();
					expect(helper.readInputBox('test-session', 'x', 'before-write').state).toBe('foreign');
					// Rule 2: markers the box showed for our pastes keep their counters.
					noteShownMarker('test-session', '[Pasted text #2 +4 lines]', A);
					noteShownMarker('test-session', '[Pasted text #3 +4 lines]', B);
					expect(helper.readInputBox('test-session', 'x', 'before-write')).toMatchObject({ ownPasteMarker: true, ownPasteMessages: [A, B] });
				});

				it('one paste of ours never accounts for two markers', async () => {
					noteHarnessPaste('test-session', A, t);
					screen = await twoMarkers();
					expect(helper.readInputBox('test-session', 'x', 'before-write').state).toBe('foreign');
				});

				it('text in an idle box we cannot attribute is never submitted, and is reported once after 10 min', async () => {
					noteHarnessPaste('test-session', A, t);
					screen = await cc('typed-single'); // "hello world probe": not one of our pastes
					const stuck: Array<{ inputLength: number; forMs: number }> = [];
					SessionCommandHelper.onStuckInput = (_s, info) => stuck.push(info);
					SessionCommandHelper.autoWatch = false;
					await watchFor(9);
					expect(stuck).toHaveLength(0);
					await watchFor(2);
					expect(stuck).toHaveLength(1);
					expect(stuck[0].inputLength).toBe('hello world probe'.length);
					await watchFor(5);
					expect(stuck).toHaveLength(1);
					expect(enters()).toBe(0);
					SessionCommandHelper.onStuckInput = null;
				});

				it('a busy agent is never reported stuck, and an emptied box resets the clock', async () => {
					noteHarnessPaste('test-session', A, t);
					screen = await cc('typed-single');
					const stuck: unknown[] = [];
					SessionCommandHelper.onStuckInput = (_s, info) => stuck.push(info);
					busy = true;
					await watchFor(11);
					expect(stuck).toHaveLength(0);
					busy = false;
					await watchFor(5);
					screen = cc_empty;
					await watchFor(1);
					screen = await cc('typed-single');
					await watchFor(6);
					expect(stuck).toHaveLength(0);
					SessionCommandHelper.onStuckInput = null;
				});
			});

			it('stays ours through a long busy turn while every read shows it (no wall-clock expiry)', async () => {
				busy = true;
				screen = await cc('busy-labelled-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('busy-labelled-pasted-marker');
				await watchFor(30);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(true);
				expect(enters()).toBe(0);
			});

			it('an unreadable screen does not end it, but unseen for OWN_PASTE_UNSEEN_MAX_MS does', async () => {
				screen = await cc('busy-labelled-pasted-marker');
				busy = true;
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-write' });
				// (box not empty: nothing pasted, nothing recorded)
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
				screen = await cc('busy-labelled-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('busy-labelled-pasted-marker');
				await watchFor(1);
				screen = null; // a dialog over the box
				await watchFor(1);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(true);
				await watchFor(2);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
			});

			it('ends after our one Enter on it, even when it stays (stuck)', async () => {
				screen = await cc('labelled-rule-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('labelled-rule-pasted-marker');
				await watchFor(1); // idle: one Enter; the marker stays (Enter lost again)
				expect(enters()).toBe(1);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
				await watchFor(5);
				expect(enters()).toBe(1);
				expect(helper.readInputBox('test-session', 'x', 'before-write').state).toBe('foreign');
			});

			it('a lost Enter after our own paste (marker seen right away) is recovered once idle', async () => {
				screen = await cc('labelled-rule-empty');
				const marker = await cc('labelled-rule-pasted-marker');
				mockSession.write.mockImplementation((d: string) => {
					if (d.startsWith('\x1b[200~')) screen = marker; // the paste lands; its Enter is lost
				});
				await helper.sendMessage('test-session', TASK);
				expect(enters()).toBe(1);
				mockSession.write.mockImplementation((d: string) => {
					if (d === '\r') screen = cc_empty;
				});
				await watchFor(1);
				expect(enters()).toBe(2);
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
			});

			it('the watcher keeps off a session a delivery is typing into', async () => {
				screen = await cc('labelled-rule-empty');
				const marker = await cc('labelled-rule-pasted-marker');
				mockSession.write.mockImplementation((d: string) => {
					if (d.startsWith('\x1b[200~')) screen = marker;
				});
				const delivery = helper.sendMessage('test-session', TASK);
				await SessionCommandHelper.watchOwnPastes(); // runs while the delivery waits for its paste to render
				await delivery;
				expect(enters()).toBe(1); // only the delivery's own Enter
			});

			it.each([
				['createSession', () => helper.createSession('test-session', '/tmp')],
				['killSession', () => helper.killSession('test-session')],
				['sendShellLine (runtime relaunch)', () => helper.sendShellLine('test-session', 'claude')],
			])('is dropped by %s', async (_name, act) => {
				screen = await cc('labelled-rule-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				await act();
				expect(SessionCommandHelper.hasOwnPaste('test-session')).toBe(false);
				screen = await cc('labelled-rule-pasted-marker');
				expect(helper.readInputBox('test-session', TASK, 'recovery').ownPasteMarker).toBeFalsy();
			});

			it('isAgentBusy: a live turn (signal where the runtime paints it, screen repainting) is busy', async () => {
				busy = true;
				expect(await helper.isAgentBusy('test-session')).toBe(true);
			});

			it('isAgentBusy: transcript text never makes an idle agent busy (live E1→S3: "esc to interrupt" / "Word…" in the reply)', async () => {
				busy = false;
				expect(await helper.isAgentBusy('test-session')).toBe(false);
				const transcriptOnly = ['⏺ Press esc to interrupt a turn.', '❯ Thanks…', '  ⎿  Waiting…', '⏺ Understood…', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
				mockBackend.captureOutput.mockImplementation(() => transcriptOnly);
				expect(await helper.isAgentBusy('test-session')).toBe(false);
			});

			it('isAgentBusy: a spinner-shaped line that does not repaint is not busy', async () => {
				const frozen = busyScreen();
				mockBackend.captureOutput.mockImplementation(() => frozen);
				expect(await helper.isAgentBusy('test-session')).toBe(false);
			});

			it('isAgentBusy: a screen still showing a turn after BUSY_FROZEN_MS without PTY output is idle (safety cap)', async () => {
				busy = true;
				mockGetRawOutputIdleMs.mockReturnValue(TUI_INPUT_GUARD.BUSY_FROZEN_MS);
				expect(await helper.isAgentBusy('test-session')).toBe(false);
				mockGetRawOutputIdleMs.mockReturnValue(1_000);
				expect(await helper.isAgentBusy('test-session')).toBe(true);
			});

			it('the watcher submits our paste once a frozen "busy" screen hits the cap', async () => {
				busy = true;
				screen = await cc('busy-labelled-empty');
				await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-submit' });
				screen = await cc('busy-labelled-pasted-marker');
				mockSession.write.mockImplementation((d: string) => {
					if (d === '\r') screen = cc_empty;
				});
				await watchFor(1);
				expect(enters()).toBe(0);
				mockGetRawOutputIdleMs.mockReturnValue(TUI_INPUT_GUARD.BUSY_FROZEN_MS + 1);
				mockGetIdleTimeMs.mockImplementation(() => 999999);
				await watchFor(1);
				expect(enters()).toBe(1);
			});
		});

		describe('labelled top rule (live: "──── crewly-orc ─"), real Claude Code 2.1.288 captures', () => {
			it('reads the empty box and our marker, idle and busy', async () => {
				expect(helper.readInputBox('x', '', 'recovery').state).toBe('unknown');
				script([await cc('labelled-rule-empty')]);
				expect(helper.readInputBox('test-session', TASK, 'before-write')).toMatchObject({ state: 'empty', layout: 'claude-code' });
				script([await cc('busy-labelled-empty')]);
				expect(helper.readInputBox('test-session', TASK, 'before-write')).toMatchObject({ state: 'empty', layout: 'claude-code' });
				script([await cc('busy-labelled-pasted-marker')]);
				expect(helper.readInputBox('test-session', TASK, 'after-paste')).toMatchObject({ state: 'ours', text: '[Pasted text #2 +4 lines]' });
			});

			it('delivers into a labelled box: paste → marker → one Enter', async () => {
				SessionCommandHelper.resetOwnPasteMarkersForTesting();
				script([await cc('labelled-rule-empty'), await cc('labelled-rule-pasted-marker')]);
				await helper.sendMessage('test-session', TASK);
				expect(writes()).toEqual([PASTE(TASK), '\r']);
				SessionCommandHelper.resetOwnPasteMarkersForTesting();
			});
		});

		it('submitIfInputIsOurs presses Enter only for our own text and reports what it saw', async () => {
			script([await cc('after-turn-empty-box')]);
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('empty');
			script([await cc('accepted-suggestion')]);
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('foreign');
			expect(mockSession.write).not.toHaveBeenCalled();
			script([await cc('typed-single')]);
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('ours');
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});

		it('submitIfInputIsOurs reports unknown (no Enter) without a styled capture', async () => {
			delete (mockBackend as any).captureInputView;
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('unknown');
			expect(mockSession.write).not.toHaveBeenCalled();
		});
	});

	describe('sendKey', () => {
		it('should send special key codes', async () => {
			await helper.sendKey('test-session', 'Enter');
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});

		it('should send Ctrl+C key code', async () => {
			await helper.sendKey('test-session', 'C-c');
			expect(mockSession.write).toHaveBeenCalledWith('\x03');
		});

		it('should send literal key if not special', async () => {
			await helper.sendKey('test-session', 'a');
			expect(mockSession.write).toHaveBeenCalledWith('a');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendKey('non-existent', 'Enter')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendCtrlC', () => {
		it('should send Ctrl+C character', async () => {
			await helper.sendCtrlC('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\x03');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendCtrlC('non-existent')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendEnter', () => {
		it('should send Enter character', async () => {
			await helper.sendEnter('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});
	});

	describe('sendEscape', () => {
		it('should send Escape character', async () => {
			await helper.sendEscape('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});
	});

	describe('clearCurrentCommandLine', () => {
		it('should send Ctrl+C then Ctrl+U', async () => {
			await helper.clearCurrentCommandLine('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\x03');
			expect(mockSession.write).toHaveBeenCalledWith('\x15');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.clearCurrentCommandLine('non-existent')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('capturePane', () => {
		it('should return captured output with trailing empty lines stripped', () => {
			mockBackend.captureOutput.mockReturnValue('content\n❯ \n\n\n');
			const output = helper.capturePane('test-session', 50);
			expect(output).toBe('content\n❯ \n');
			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 50);
		});

		it('should use default lines value of 200', () => {
			helper.capturePane('test-session');
			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 200);
		});

		it('should strip trailing whitespace-only lines from terminal buffer', () => {
			// Simulate a terminal with 50+ empty rows below content
			const emptyRows = '\n'.repeat(50);
			mockBackend.captureOutput.mockReturnValue('❯ ' + emptyRows);
			const output = helper.capturePane('test-session');
			expect(output).toBe('❯ \n');
		});
	});

	describe('getRawHistory', () => {
		it('should return raw history with ANSI codes', () => {
			const output = helper.getRawHistory('test-session');
			expect(output).toBe('raw history with \x1b[32mcolors\x1b[0m');
			expect(mockBackend.getRawHistory).toHaveBeenCalledWith('test-session');
		});
	});

	describe('listSessions', () => {
		it('should return list of sessions', () => {
			const sessions = helper.listSessions();
			expect(sessions).toEqual(['test-session']);
		});
	});

	describe('killSession', () => {
		it('should kill the session', async () => {
			await helper.killSession('test-session');
			expect(mockBackend.killSession).toHaveBeenCalledWith('test-session');
		});
	});

	describe('createSession', () => {
		it('should create a session with default options', async () => {
			const session = await helper.createSession('new-session', '/test/cwd');
			expect(mockBackend.createSession).toHaveBeenCalledWith('new-session', {
				cwd: '/test/cwd',
				command: expect.any(String),
				args: undefined,
				env: undefined,
				cols: undefined,
				rows: undefined,
			});
			expect(session).toBe(mockSession);
		});

		it('should create a session with custom options', async () => {
			await helper.createSession('new-session', '/test/cwd', {
				command: 'node',
				args: ['script.js'],
				env: { NODE_ENV: 'test' },
				cols: 120,
				rows: 40,
			});

			expect(mockBackend.createSession).toHaveBeenCalledWith('new-session', {
				cwd: '/test/cwd',
				command: 'node',
				args: ['script.js'],
				env: { NODE_ENV: 'test' },
				cols: 120,
				rows: 40,
			});
		});
	});

	describe('setEnvironmentVariable', () => {
		it('should write export command', async () => {
			await helper.setEnvironmentVariable('test-session', 'MY_VAR', 'my_value');
			expect(mockSession.write).toHaveBeenCalledWith(' export MY_VAR="my_value"\r');
		});

		it.each(['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN'])(
			'refuses to type the secret %s into the terminal, and writes nothing',
			async (key) => {
				const fakeSecret = 'AIzaTESTfakeKeyThatMustNeverBeTyped0123';
				await expect(helper.setEnvironmentVariable('test-session', key, fakeSecret)).rejects.toThrow(key);
				expect(mockSession.write).not.toHaveBeenCalled();
			}
		);

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(
				helper.setEnvironmentVariable('non-existent', 'KEY', 'VALUE')
			).rejects.toThrow("Session 'non-existent' does not exist");
		});
	});

	describe('resizeSession', () => {
		it('should resize the session', () => {
			helper.resizeSession('test-session', 120, 40);
			expect(mockSession.resize).toHaveBeenCalledWith(120, 40);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.resizeSession('non-existent', 120, 40)).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('getBackend', () => {
		it('should return the underlying backend', () => {
			expect(helper.getBackend()).toBe(mockBackend);
		});
	});

	describe('KEY_CODES', () => {
		it('should have correct key codes for control keys', () => {
			expect(KEY_CODES['Enter']).toBe('\r');
			expect(KEY_CODES['C-c']).toBe('\x03');
			expect(KEY_CODES['C-u']).toBe('\x15');
			expect(KEY_CODES['Escape']).toBe('\x1b');
			expect(KEY_CODES['Tab']).toBe('\t');
		});

		it('should have correct escape sequences for function keys', () => {
			expect(KEY_CODES['F1']).toBe('\x1bOP');
			expect(KEY_CODES['F5']).toBe('\x1b[15~');
			expect(KEY_CODES['F12']).toBe('\x1b[24~');
		});

		it('should send F12 escape sequence (not literal text) to PTY', async () => {
			await helper.sendKey('test-session', 'F12');
			// Must send the escape sequence, NOT the literal string "F12"
			expect(mockSession.write).toHaveBeenCalledWith('\x1b[24~');
			expect(mockSession.write).not.toHaveBeenCalledWith('F12');
		});
	});

	describe('createSessionCommandHelper', () => {
		it('should create a SessionCommandHelper instance', () => {
			const newHelper = createSessionCommandHelper(mockBackend);
			expect(newHelper).toBeInstanceOf(SessionCommandHelper);
		});
	});

	describe('subscribeToOutput', () => {
		it('should subscribe to session onData events', () => {
			const callback = jest.fn();
			const mockUnsubscribe = jest.fn();
			mockSession.onData.mockReturnValue(mockUnsubscribe);

			const unsubscribe = helper.subscribeToOutput('test-session', callback);

			expect(mockSession.onData).toHaveBeenCalledWith(callback);
			expect(unsubscribe).toBe(mockUnsubscribe);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.subscribeToOutput('non-existent', jest.fn())).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('subscribeToExit', () => {
		it('should subscribe to session onExit events', () => {
			const callback = jest.fn();
			const mockUnsubscribe = jest.fn();
			mockSession.onExit.mockReturnValue(mockUnsubscribe);

			const unsubscribe = helper.subscribeToExit('test-session', callback);

			expect(mockSession.onExit).toHaveBeenCalledWith(callback);
			expect(unsubscribe).toBe(mockUnsubscribe);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.subscribeToExit('non-existent', jest.fn())).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('waitForPattern', () => {
		it('should resolve when string pattern matches', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.waitForPattern('test-session', 'ready', 5000);

			// Simulate data arriving
			capturedCallback!('loading...');
			capturedCallback!('ready');

			const result = await promise;
			expect(result).toBe('loading...ready');
		});

		it('should resolve when regex pattern matches', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.waitForPattern('test-session', />\s*$/, 5000);

			capturedCallback!('output');
			capturedCallback!('\n> ');

			const result = await promise;
			expect(result).toBe('output\n> ');
		});

		it('should timeout if pattern not found', async () => {
			mockSession.onData.mockImplementation(() => jest.fn());

			await expect(helper.waitForPattern('test-session', 'never-appears', 100)).rejects.toThrow(
				'Timeout waiting for pattern'
			);
		});

		it('should cleanup subscription on match', async () => {
			const mockUnsubscribe = jest.fn();
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return mockUnsubscribe;
			});

			const promise = helper.waitForPattern('test-session', 'found', 5000);
			capturedCallback!('found');
			await promise;

			expect(mockUnsubscribe).toHaveBeenCalled();
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.waitForPattern('non-existent', 'test', 100)).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('waitForAnyPattern', () => {
		it('should resolve with matching pattern id', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const patterns = [
				{ id: 'success', pattern: /success/i },
				{ id: 'error', pattern: /error/i },
			];

			const promise = helper.waitForAnyPattern('test-session', patterns, 5000);

			capturedCallback!('ERROR: something failed');

			const result = await promise;
			expect(result.matchedId).toBe('error');
			expect(result.buffer).toBe('ERROR: something failed');
		});

		it('should match first pattern when multiple could match', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const patterns = [
				{ id: 'first', pattern: 'test' },
				{ id: 'second', pattern: 'test message' },
			];

			const promise = helper.waitForAnyPattern('test-session', patterns, 5000);

			capturedCallback!('test message');

			const result = await promise;
			expect(result.matchedId).toBe('first');
		});

		it('should timeout if no pattern matches', async () => {
			mockSession.onData.mockImplementation(() => jest.fn());

			const patterns = [
				{ id: 'a', pattern: 'pattern-a' },
				{ id: 'b', pattern: 'pattern-b' },
			];

			await expect(helper.waitForAnyPattern('test-session', patterns, 100)).rejects.toThrow(
				'Timeout waiting for any pattern'
			);
		});
	});

	describe('writeRaw', () => {
		it('should write raw data without Enter key', () => {
			helper.writeRaw('test-session', 'raw input');
			expect(mockSession.write).toHaveBeenCalledWith('raw input');
			expect(mockSession.write).toHaveBeenCalledTimes(1);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.writeRaw('non-existent', 'data')).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('dismissInteractivePromptIfNeeded', () => {
		it('should NOT send Escape to an idle Claude screen whose footer says "shift+tab to cycle" (#815)', async () => {
			mockBackend.captureOutput.mockReturnValue('Some output\n❯❯ bypass permissions on (shift+tab to cycle)');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(false);
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should detect the real plan-approval menu and send Escape', async () => {
			mockBackend.captureOutput.mockReturnValue(
				' Claude has written up a plan and is ready to execute. Would you like to proceed?\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits',
			);
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});

		it('should detect ExitPlanMode pattern', async () => {
			mockBackend.captureOutput.mockReturnValue('Use ExitPlanMode when ready');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});

		it('should detect Plan mode pattern', async () => {
			mockBackend.captureOutput.mockReturnValue('Plan mode active');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(true);
		});

		it('should return false when no plan mode detected', async () => {
			mockBackend.captureOutput.mockReturnValue('Normal terminal output\n❯ ');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(false);
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should skip plan mode dismissal when agent is busy (low idle time)', async () => {
			// Agent is actively processing — idle time below threshold
			mockGetIdleTimeMs.mockReturnValue(1000); // 1s idle < 5s threshold = busy

			// Even though plan mode text is in the output, should skip because agent is busy
			mockBackend.captureOutput.mockReturnValue('Plan mode active');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(false);
			expect(mockSession.write).not.toHaveBeenCalled();
		});
	});

});
