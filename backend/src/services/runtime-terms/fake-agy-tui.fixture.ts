/**
 * Tests-only fake of Antigravity CLI's first-run TUI (agy 1.2.14): a
 * scripted terminal that takes the raw bytes a PTY would get, renders the
 * screens the real binary paints (same text, same focus markers) and
 * records every key, so a test can check exactly what was pressed and the
 * resulting checkbox state.
 *
 * Behaviour copied from the real binary:
 * - colour list: ↑/↓ move (wrapping inside the list), Enter chooses (`* name`);
 *   without Gemini CLI extensions Enter goes straight to the Terms screen,
 *   with them the focus moves to "Import extensions…" (↑ from there returns
 *   to the bottom of the list and un-chooses the scheme), then Next;
 * - Terms: the data item starts checked; Enter / Space toggle it; ↓ moves to
 *   the buttons ([Previous] first), ←/→ between them, ↑ back to the item;
 *   Enter on Previous goes back, Enter on Done accepts and shows the prompt.
 *
 * @module services/runtime-terms/fake-agy-tui.fixture
 */

import type { TermsTerminal } from './antigravity-terms-driver.js';

const SCHEMES = ['terminal', 'light', 'solarized light', 'colorblind-friendly light', 'dark', 'solarized dark', 'colorblind-friendly dark', 'tokyo night'];

/** Keys decoded from the bytes received. */
export type FakeKey = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter' | 'Space' | 'CtrlC' | 'Other';

const BYTES: Record<string, FakeKey> = {
	'\x1b[A': 'Up',
	'\x1b[B': 'Down',
	'\x1b[C': 'Right',
	'\x1b[D': 'Left',
	'\r': 'Enter',
	' ': 'Space',
	'\x03': 'CtrlC',
};

/** Options. */
export interface FakeAgyOptions {
	/** Gemini CLI extensions exist (shows "Migration options") */
	migration?: boolean;
	/** Start on the prompt (terms already accepted) */
	alreadyAccepted?: boolean;
	/** Paint a different Terms screen (wording changed in a new version) */
	changedTerms?: boolean;
	/** Paint an account sign-in instead of the setup screens */
	accountLogin?: boolean;
	/** Toggling the data box does nothing (a stuck TUI) */
	stuckCheckbox?: boolean;
	/** Starting focus in the colour list */
	startScheme?: string;
}

/** The fake. */
export class FakeAgyTui implements TermsTerminal {
	/** Every key received, in order */
	readonly keys: FakeKey[] = [];
	screenName: 'color' | 'terms' | 'main' | 'exited' | 'login' = 'color';
	focusZone: 'list' | 'import' | 'next' = 'list';
	focusIdx = 0;
	chosen: string | null = null;
	importChecked = false;
	termsFocus: 'data' | 'previous' | 'done' = 'data';
	dataChecked = true;
	/** What Done accepted, once pressed */
	accepted: { scheme: string | null; importExtensions: boolean; dataSharing: boolean } | null = null;
	/** Times Done was pressed */
	doneCount = 0;

	/**
	 * @param opts - Scenario
	 */
	constructor(private readonly opts: FakeAgyOptions = {}) {
		if (opts.alreadyAccepted) this.screenName = 'main';
		if (opts.accountLogin) this.screenName = 'login';
		if (opts.startScheme) this.focusIdx = Math.max(0, SCHEMES.indexOf(opts.startScheme));
	}

	/**
	 * Receive bytes as a PTY would.
	 *
	 * @param data - Raw bytes
	 */
	write(data: string): void {
		let rest = data;
		while (rest.length > 0) {
			const seq = Object.keys(BYTES).find((b) => rest.startsWith(b));
			const key: FakeKey = seq ? BYTES[seq] : 'Other';
			rest = rest.slice(seq ? seq.length : 1);
			this.keys.push(key);
			this.press(key);
		}
	}

	private press(key: FakeKey): void {
		if (key === 'CtrlC') {
			this.screenName = 'exited';
			return;
		}
		if (this.screenName === 'color') this.pressColor(key);
		else if (this.screenName === 'terms') this.pressTerms(key);
	}

	private pressColor(key: FakeKey): void {
		const migration = Boolean(this.opts.migration);
		if (this.focusZone === 'list') {
			if (key === 'Up') this.focusIdx = (this.focusIdx + SCHEMES.length - 1) % SCHEMES.length;
			else if (key === 'Down') this.focusIdx = (this.focusIdx + 1) % SCHEMES.length;
			else if (key === 'Enter') {
				this.chosen = SCHEMES[this.focusIdx];
				if (migration) this.focusZone = 'import';
				else this.screenName = 'terms';
			}
			return;
		}
		if (this.focusZone === 'import') {
			if (key === 'Enter' || key === 'Space') this.importChecked = !this.importChecked;
			else if (key === 'Down') this.focusZone = 'next';
			else if (key === 'Up') {
				this.focusZone = 'list';
				this.focusIdx = SCHEMES.length - 1;
				this.chosen = null;
			}
			return;
		}
		if (key === 'Up') this.focusZone = 'import';
		else if (key === 'Enter') this.screenName = 'terms';
	}

	private pressTerms(key: FakeKey): void {
		if (this.termsFocus === 'data') {
			if ((key === 'Enter' || key === 'Space') && !this.opts.stuckCheckbox) this.dataChecked = !this.dataChecked;
			else if (key === 'Down') this.termsFocus = 'previous';
			return;
		}
		if (key === 'Up') this.termsFocus = 'data';
		else if (key === 'Right') this.termsFocus = 'done';
		else if (key === 'Left') this.termsFocus = 'previous';
		else if (key === 'Enter') {
			if (this.termsFocus === 'previous') {
				this.screenName = 'color';
				this.focusZone = 'list';
				return;
			}
			this.doneCount += 1;
			this.accepted = { scheme: this.chosen, importExtensions: this.importChecked, dataSharing: this.dataChecked };
			this.screenName = 'main';
		}
	}

	/** @returns The screen as text */
	capture(): string {
		switch (this.screenName) {
			case 'main':
				return [
					'  Antigravity CLI 1.2.14',
					'  Gemini API key',
					'─'.repeat(60),
					'> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
					'─'.repeat(60),
					'? for shortcuts            accept-edits · Gemini 3.1 Pro · low',
				].join('\n');
			case 'exited':
				return '$ ';
			case 'login':
				return ' Welcome to the Antigravity CLI. You are currently not signed in.\n\n Select login method:\n > 1. Google OAuth\n   2. Use a Google Cloud project';
			case 'terms':
				return this.renderTerms();
			default:
				return this.renderColor();
		}
	}

	private renderColor(): string {
		const box = '│ > you: add a greeting function                              │';
		const lines = ['    ▄▀▀▄', '', 'Welcome to Antigravity CLI!', '', 'Choose your color scheme:        ╭──────────────────────────╮'];
		SCHEMES.forEach((name, i) => {
			const focused = this.focusZone === 'list' && i === this.focusIdx;
			const marker = focused ? '>' : this.chosen === name ? '*' : ' ';
			lines.push(`  ${marker} ${name}`.padEnd(33) + box);
		});
		lines.push('                                 ╰──────────────────────────╯', '');
		if (this.opts.migration) {
			lines.push('Migration options:');
			const f = this.focusZone === 'import' ? '>' : ' ';
			lines.push(`  ${f} [${this.importChecked ? 'x' : ' '}] Import extensions from Gemini CLI (1 found: google-workspace)`, '');
			lines.push(this.focusZone === 'next' ? '  >  Next' : '    [Next]');
		} else {
			lines.push('    [Next]');
		}
		lines.push('', `  ↑/↓ Navigate · enter ${this.focusZone === 'import' ? 'Toggle' : 'Confirm'}`);
		return lines.join('\n');
	}

	private renderTerms(): string {
		const title = 'Terms of Service & Data Use';
		const item = this.opts.changedTerms
			? 'Allow Google to use my Interactions data to improve its products.'
			: 'Yes, I agree to help improve Antigravity CLI by allowing';
		const f = this.termsFocus === 'data' ? '>' : ' ';
		const buttons =
			this.termsFocus === 'previous' ? '  >  Previous       [Done]' : this.termsFocus === 'done' ? '    [Previous]    >  Done' : '    [Previous]      [Done]';
		return [
			'    ▄▀▀▄',
			'',
			title,
			'',
			'AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration,',
			'prompt injection and supply chain risks. Ensure that you monitor and verify all actions taken by the agent.',
			'',
			'-'.repeat(120),
			'',
			`  ${f} [${this.dataChecked ? 'x' : ' '}] ${item}`,
			'      Google to collect and use my Interactions data,',
			'      subject to the Google Antigravity CLI Terms of Service',
			'      and Google Privacy Policy. I understand I can',
			'      choose to opt out later whenever I want via my',
			'      settings.',
			'',
			'      Links:',
			'      - Terms of Service: https://antigravity.google/terms',
			'      - Privacy Policy: https://policies.google.com/privacy',
			'',
			buttons,
			'',
			'',
			'  ↑/↓ Navigate · enter Toggle',
		].join('\n');
	}
}
