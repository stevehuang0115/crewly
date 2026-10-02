/**
 * Tests for the runtime-fallback wiring helpers (handover file).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { crewlyAgentModelsInUse, writeRuntimeHandover } from './runtime-fallback.wiring.js';

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

	it("reads the transcript of another Claude Code account from that account's config dir (#942)", () => {
		const previous = process.env.CREWLY_HOME;
		process.env.CREWLY_HOME = home;
		try {
			const cwd = path.join(home, 'proj');
			const slug = path.resolve(cwd).replace(/[/.]/g, '-');
			const dir = path.join(home, 'claude-accounts', 'b', 'projects', slug);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, 'conv-b.jsonl'),
				`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Deploy the site' } })}\n` +
					`${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Deploying now.' }] } })}\n`,
			);
			const file = writeRuntimeHandover(
				home,
				{ sessionName: 'dev-1', from: 'claude-code@b', to: 'crewly-agent', direction: 'switch', conversationId: 'conv-b', workItem: null },
				cwd,
			);
			const text = fs.readFileSync(file, 'utf-8');
			expect(text).toContain('You were running on Claude Code (b).');
			expect(text).not.toContain('is not readable here');
		} finally {
			if (previous === undefined) delete process.env.CREWLY_HOME;
			else process.env.CREWLY_HOME = previous;
		}
	});

	it('words a revert', () => {
		const file = writeRuntimeHandover(home, { sessionName: 'dev-1', from: 'crewly-agent', to: 'claude-code', direction: 'revert', conversationId: null, workItem: null }, undefined);
		expect(fs.readFileSync(file, 'utf-8')).toContain('Claude Code is back, so Crewly moved you back.');
	});
});

describe('crewlyAgentModelsInUse', () => {
	it('lists each provider the Crewly Agent runtime uses (orchestrator + members), once', async () => {
		const storage = {
			getOrchestratorStatus: async () => ({ runtimeType: 'crewly-agent', modelId: 'deepseek/deepseek-chat' }),
			getProjects: async () => [],
			getTeams: async () => [
				{
					id: 't1',
					name: 'T',
					projectIds: [],
					members: [
						{ id: 'm1', name: 'A', role: 'dev', sessionName: 'a', runtimeType: 'crewly-agent', modelId: 'deepseek/deepseek-reasoner' },
						{ id: 'm2', name: 'B', role: 'dev', sessionName: 'b', runtimeType: 'claude-code', modelId: 'opus' },
						{ id: 'm3', name: 'C', role: 'dev', sessionName: 'c', runtimeType: 'crewly-agent' },
					],
				},
			],
		};
		await expect(crewlyAgentModelsInUse(storage)).resolves.toEqual([
			{ provider: 'deepseek', model: 'deepseek-chat' },
			{ provider: 'google' },
		]);
	});
});
