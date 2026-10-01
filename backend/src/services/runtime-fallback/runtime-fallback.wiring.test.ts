/**
 * Tests for the runtime-fallback wiring helpers (handover file).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeRuntimeHandover } from './runtime-fallback.wiring.js';

describe('writeRuntimeHandover', () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-handover-'));
	});
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('writes a switch handover with the WorkItem under CREWLY_HOME/handover', () => {
		const file = writeRuntimeHandover(
			home,
			{ sessionName: 'dev-1', from: 'codex-cli', to: 'crewly-agent', direction: 'switch', conversationId: null, workItem: { id: 'wi-1', title: 'Ship it' } },
			undefined,
			new Date(Date.UTC(2026, 9, 1, 12)),
		);
		expect(path.dirname(file)).toBe(path.join(home, 'handover'));
		const text = fs.readFileSync(file, 'utf-8');
		expect(text).toContain('You were running on Codex. It ran out of usage, so Crewly moved you to Crewly Agent until it resets.');
		expect(text).toContain('WorkItem wi-1 ("Ship it")');
		expect(text).toContain('is not readable here');
	});

	it('includes the end of a Claude Code transcript when there is one', () => {
		const cwd = path.join(home, 'proj');
		const claudeHome = path.join(os.homedir(), '.claude');
		const slug = path.resolve(cwd).replace(/[/.]/g, '-');
		const dir = path.join(claudeHome, 'projects', slug);
		fs.mkdirSync(dir, { recursive: true });
		const transcript = path.join(dir, 'conv-1.jsonl');
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Please fix the login page' } })}\n` +
				`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on the login page fix now.' }] } })}\n`,
		);
		try {
			const file = writeRuntimeHandover(
				home,
				{ sessionName: 'dev-1', from: 'claude-code', to: 'crewly-agent', direction: 'switch', conversationId: 'conv-1', workItem: null },
				cwd,
			);
			const text = fs.readFileSync(file, 'utf-8');
			expect(text).toContain('You were running on Claude Code.');
			expect(text).not.toContain('is not readable here');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('words a revert', () => {
		const file = writeRuntimeHandover(home, { sessionName: 'dev-1', from: 'crewly-agent', to: 'claude-code', direction: 'revert', conversationId: null, workItem: null }, undefined);
		expect(fs.readFileSync(file, 'utf-8')).toContain('Claude Code is back, so Crewly moved you back.');
	});
});
