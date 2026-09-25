/**
 * Tests for the orchestrator harness store.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OrcHarnessStore } from './orc-harness.store.js';

describe('OrcHarnessStore', () => {
	let home: string;
	let updateDefaultRuntime: jest.Mock;
	let store: OrcHarnessStore;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-harness-'));
		updateDefaultRuntime = jest.fn(async () => undefined);
		store = new OrcHarnessStore({ crewlyHome: () => home, updateDefaultRuntime });
	});
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('uses the orchestrator config StorageService uses', () => {
		expect(store.getFilePath()).toBe(path.join(home, 'teams', 'orchestrator', 'config.json'));
	});

	it('reports null on a fresh machine and does not create the file', async () => {
		expect(await store.get()).toBeNull();
		expect(fs.existsSync(store.getFilePath())).toBe(false);
	});

	it('creates the orchestrator config with the chosen harness', async () => {
		expect(await store.set('codex-cli')).toBe('codex-cli');
		const config = JSON.parse(fs.readFileSync(store.getFilePath(), 'utf-8'));
		expect(config).toMatchObject({ sessionName: 'crewly-orc', agentStatus: 'inactive', workingStatus: 'idle', runtimeType: 'codex-cli' });
		expect(await store.get()).toBe('codex-cli');
		expect(updateDefaultRuntime).toHaveBeenCalledWith('codex-cli');
	});

	it('keeps other orchestrator fields when switching', async () => {
		fs.mkdirSync(path.dirname(store.getFilePath()), { recursive: true });
		fs.writeFileSync(store.getFilePath(), JSON.stringify({ sessionName: 'crewly-orc', runtimeType: 'claude-code', modelId: 'opus', agentStatus: 'active' }));
		await store.set('gemini-cli');
		const config = JSON.parse(fs.readFileSync(store.getFilePath(), 'utf-8'));
		expect(config).toMatchObject({ runtimeType: 'gemini-cli', modelId: 'opus', agentStatus: 'active' });
		expect(typeof config.updatedAt).toBe('string');
	});

	it('does not fail the orc choice when the settings update fails', async () => {
		const failing = new OrcHarnessStore({ crewlyHome: () => home, updateDefaultRuntime: async () => { throw new Error('bad settings'); } });
		await expect(failing.set('codex-cli')).resolves.toBe('codex-cli');
		expect(await failing.get()).toBe('codex-cli');
	});

	it('treats a config without runtimeType as not chosen', async () => {
		fs.mkdirSync(path.dirname(store.getFilePath()), { recursive: true });
		fs.writeFileSync(store.getFilePath(), JSON.stringify({ sessionName: 'crewly-orc' }));
		expect(await store.get()).toBeNull();
	});
});
