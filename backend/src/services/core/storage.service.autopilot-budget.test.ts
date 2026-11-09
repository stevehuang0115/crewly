/**
 * Regression for crewly#1099 gap 2: an owner-approved raise of the autopilot's
 * daily budget was reverted by a later whole-record save from a stale copy.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { StorageService } from './storage.service.js';
import type { Project } from '../../types/index.js';

const project = (budget: number): Project =>
	({
		id: 'p1',
		name: 'CE',
		path: '/tmp/ce',
		teams: {},
		status: 'stopped',
		ticketAutopilot: { enabled: true, dailyBudgetTokens: budget },
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-10-01T00:00:00.000Z',
	}) as Project;

describe('StorageService.saveProject and the autopilot budget (#1099)', () => {
	let home: string;
	let storage: StorageService;
	let info: jest.SpyInstance;
	let warn: jest.SpyInstance;

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-1099-'));
		StorageService.clearInstance();
		storage = StorageService.getInstance(home);
		const logger = (storage as any).logger;
		info = jest.spyOn(logger, 'info');
		warn = jest.spyOn(logger, 'warn');
		await storage.saveProject(project(50_000_000));
	});

	afterEach(async () => {
		StorageService.clearInstance();
		await fs.rm(home, { recursive: true, force: true });
	});

	const stored = async (): Promise<Project> => (await storage.getProjects()).find((p) => p.id === 'p1') as Project;

	it('keeps an owner raise when a stale copy of the project is saved later', async () => {
		const stale = await stored(); // loaded before the raise
		await storage.saveProject({ ...stale, ticketAutopilot: { enabled: true, dailyBudgetTokens: 150_000_000 } }, { ticketAutopilot: 'replace', caller: 'test raise' });
		await storage.saveProject({ ...stale, status: 'active', updatedAt: '2026-10-05T03:49:26.000Z' }); // restart-time save of the stale copy
		const after = await stored();
		expect(after.status).toBe('active');
		expect(after.ticketAutopilot?.dailyBudgetTokens).toBe(150_000_000);
		expect(warn).toHaveBeenCalledWith(
			'Ignored a stale ticketAutopilot budget on project save (kept the stored value)',
			expect.objectContaining({ storedBudgetTokens: 150_000_000, staleBudgetTokens: 50_000_000 }),
		);
	});

	it('does not lose a raise when saves race', async () => {
		const stale = await stored();
		await Promise.all([
			storage.saveProject({ ...stale, ticketAutopilot: { enabled: true, dailyBudgetTokens: 150_000_000 } }, { ticketAutopilot: 'replace', caller: 'raise' }),
			storage.saveProject({ ...stale, firstLaunchedAt: 'now' }),
			storage.saveProject({ ...stale, status: 'paused' }),
		]);
		expect((await stored()).ticketAutopilot?.dailyBudgetTokens).toBe(150_000_000);
	});

	it('logs every budget write with its caller and old and new value', async () => {
		const cur = await stored();
		await storage.saveProject({ ...cur, ticketAutopilot: { enabled: true, dailyBudgetTokens: 150_000_000 } }, { ticketAutopilot: 'replace', caller: 'autopilot.updateSettings by owner' });
		expect(info).toHaveBeenCalledWith('Ticket autopilot daily budget changed', { projectId: 'p1', caller: 'autopilot.updateSettings by owner', from: 50_000_000, to: 150_000_000 });
	});

	it('does not log a budget change when the budget is unchanged', async () => {
		info.mockClear();
		await storage.saveProject({ ...(await stored()), status: 'active' });
		expect(info).not.toHaveBeenCalledWith('Ticket autopilot daily budget changed', expect.anything());
	});
});
