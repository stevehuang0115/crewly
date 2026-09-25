/**
 * Integration: the runtime `crewly init` saves is the one the backend's
 * orchestrator reads (B8 D1). Real files in a temporary CREWLY_HOME; the
 * backend side is StorageService.getOrchestratorStatus, which both the boot
 * auto-start and OrchestratorRestartService use to pick the runtime.
 */
// chalk is ESM-only; the CLI's unit tests stub it the same way.
jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy({}, {
		get: () => {
			const fn = (s: string) => s;
			return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
		},
	}),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { persistOrchestratorRuntime } from './onboard.js';
import { StorageService } from '../../../backend/src/services/core/storage.service.js';

describe('crewly init → orchestrator runtime (integration)', () => {
	let home: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-init-orc-'));
		previousHome = process.env.CREWLY_HOME;
		process.env.CREWLY_HOME = home;
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.CREWLY_HOME;
		else process.env.CREWLY_HOME = previousHome;
		jest.restoreAllMocks();
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('the backend reads gemini-cli after init chose Gemini (it defaulted to claude-code before)', async () => {
		expect(persistOrchestratorRuntime('gemini')).toBe('gemini-cli');

		const status = await new StorageService(home).getOrchestratorStatus();

		expect(status?.runtimeType).toBe('gemini-cli');
	});

	it('keeps the other fields of an existing orchestrator config', async () => {
		const file = path.join(home, 'teams', 'orchestrator', 'config.json');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ sessionName: 'crewly-orc', runtimeType: 'claude-code', modelId: 'keep-me', agentStatus: 'inactive', workingStatus: 'idle', createdAt: 'then', updatedAt: 'then' }));

		persistOrchestratorRuntime('codex');

		const status = await new StorageService(home).getOrchestratorStatus();
		expect(status).toEqual(expect.objectContaining({ runtimeType: 'codex-cli', modelId: 'keep-me', createdAt: 'then' }));
	});
});
