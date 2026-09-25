import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';
import type { MarketplaceItem, MarketplaceOperationResult } from '../../types/marketplace.types.js';
import type { ResolvedSkill, SkillDiscoveryService } from './skill-discovery.service.js';
import {
	SkillInstallError,
	SkillInstallJobService,
	describeStartedJob,
	formatCompletionMessage,
	isOwnerInstallApproval,
	type SkillInstallJobDeps,
} from './skill-install-job.service.js';
import type { RunSetupInput, SetupResult, SkillSetupRunner } from './skill-setup-runner.service.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

const manifest = { estimatedMinutes: 6, steps: [{ id: 'ffmpeg', type: 'command' as const, check: { commands: ['ffmpeg'] } }] };

/**
 * A resolved skill for the fake discovery.
 *
 * @param over - Overrides
 * @returns Skill
 */
function skill(over: Partial<ResolvedSkill> = {}): ResolvedSkill {
	return {
		id: 'transcribe-audio',
		name: 'transcribe-audio',
		description: '',
		tags: [],
		triggers: [],
		source: 'bundled',
		official: true,
		officialReason: 'bundled with Crewly',
		installed: true,
		skillDir: '/pkg/config/skills/agent/transcribe-audio',
		executePath: '/pkg/config/skills/agent/transcribe-audio/execute.sh',
		setup: { declared: true, estimatedMinutes: 6 },
		score: 0,
		manifest,
		...over,
	};
}

/** Fake discovery serving fixed skills; `ready` controls the probe result. */
function fakeDiscovery(skills: ResolvedSkill[], ready = false): SkillDiscoveryService {
	return {
		resolve: jest.fn(async (id: string) => {
			const s = skills.find((x) => x.id === id);
			return s ? { ...s, setup: { ...s.setup } } : null;
		}),
		probe: jest.fn(async (s: ResolvedSkill) => {
			s.ready = ready;
			return s;
		}),
	} as unknown as SkillDiscoveryService;
}

/** Runner fake whose setup result the test controls. */
function fakeRunner(result: Partial<SetupResult> = {}): SkillSetupRunner & { calls: RunSetupInput[] } {
	const calls: RunSetupInput[] = [];
	return {
		calls,
		runSetup: jest.fn(async (input: RunSetupInput) => {
			calls.push(input);
			input.onProgress?.({ skillId: input.skillId, stepId: 'ffmpeg', phase: 'installing', message: 'brew install ffmpeg' });
			return {
				skillId: input.skillId,
				success: true,
				checkOnly: false,
				logFile: '/home/.crewly/logs/skill-setup/transcribe-audio.log',
				durationMs: 1000,
				steps: [
					{ id: 'jq', type: 'command', status: 'satisfied', message: 'already satisfied', optional: false },
					{ id: 'ffmpeg', type: 'command', status: 'installed', message: 'installed', optional: false },
				],
				...result,
			} as SetupResult;
		}),
	} as unknown as SkillSetupRunner & { calls: RunSetupInput[] };
}

let enqueued: EnqueueMessageInput[];

/**
 * Build the service with fakes.
 *
 * @param deps - Overrides
 * @returns Service
 */
function service(deps: SkillInstallJobDeps): SkillInstallJobService {
	return new SkillInstallJobService({
		runner: fakeRunner(),
		recentOwnerMessages: () => [],
		enqueue: (input) => enqueued.push(input),
		idFactory: () => 'job1',
		...deps,
	});
}

beforeEach(() => {
	enqueued = [];
});

describe('isOwnerInstallApproval', () => {
	const s = { id: 'shady-ocr', name: 'Shady OCR' };
	it('accepts clear approvals and a short yes that names the skill', () => {
		expect(isOwnerInstallApproval('go ahead', s)).toBe(true);
		expect(isOwnerInstallApproval('批准', s)).toBe(true);
		expect(isOwnerInstallApproval('ok, install shady-ocr', s)).toBe(true);
		expect(isOwnerInstallApproval('可以，装 Shady OCR 吧', s)).toBe(true);
	});

	it('rejects questions, unrelated chatter and a bare ok', () => {
		expect(isOwnerInstallApproval('should we install shady-ocr?', s)).toBe(false);
		expect(isOwnerInstallApproval('要不要装 shady-ocr', s)).toBe(false);
		expect(isOwnerInstallApproval('ok', s)).toBe(false);
		expect(isOwnerInstallApproval('what is the weather', s)).toBe(false);
	});
});

describe('SkillInstallJobService — official skills', () => {
	it('starts a background job at once and messages the requesting agent when it succeeds', async () => {
		const runner = fakeRunner();
		const svc = service({ discovery: fakeDiscovery([skill()]), runner });
		const started = await svc.startInstall({ skillId: 'transcribe-audio', requesterSession: 'dev-1', resumeNote: 'transcribe /tmp/clip.m4a for Steve' });
		expect(started.kind).toBe('job');
		if (started.kind !== 'job') return;
		expect(started.job).toMatchObject({ jobId: 'job1', skillId: 'transcribe-audio', state: 'running', official: true, estimatedMinutes: 6 });
		expect(describeStartedJob(started.job)).toMatch(/Installing transcribe-audio in the background \(about 6 min\)/);

		const done = await svc.waitForJob('job1');
		expect(done.state).toBe('succeeded');
		expect(done.notified).toBe(true);
		expect(done.log).toMatch(/\[ffmpeg\] installing: brew install ffmpeg/);
		expect(runner.calls[0]).toMatchObject({ skillId: 'transcribe-audio', skillDir: '/pkg/config/skills/agent/transcribe-audio', manifest });

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]).toMatchObject({ source: 'system_event', targetSession: 'dev-1', conversationId: 'system' });
		const msg = enqueued[0].content;
		expect(msg).toMatch(/^\[SKILL INSTALLED\] transcribe-audio is installed and ready \(job job1/);
		expect(msg).toMatch(/Setup: jq already there · ffmpeg installed/);
		expect(msg).toMatch(/Run it: bash \/pkg\/config\/skills\/agent\/transcribe-audio\/execute\.sh/);
		expect(msg).toMatch(/You paused: "transcribe \/tmp\/clip\.m4a for Steve"/);
		expect(msg).toMatch(/then do the task you paused/);
	});

	it('messages the failure reason (and log) when setup fails', async () => {
		const runner = fakeRunner({ success: false, error: 'ffmpeg: installing ffmpeg needs root (apt-get)… Ask the owner to run: sudo apt-get install -y ffmpeg', steps: [{ id: 'ffmpeg', type: 'command', status: 'failed', message: 'x', optional: false }] });
		const svc = service({ discovery: fakeDiscovery([skill()]), runner });
		await svc.startInstall({ skillId: 'transcribe-audio', requesterSession: 'dev-1' });
		const done = await svc.waitForJob('job1');
		expect(done.state).toBe('failed');
		const msg = enqueued[0].content;
		expect(msg).toMatch(/^\[SKILL INSTALL FAILED\] transcribe-audio \(job job1, \d+s\): ffmpeg: installing ffmpeg needs root/);
		expect(msg).toMatch(/sudo apt-get install -y ffmpeg/);
		expect(msg).toMatch(/Log: \/home\/\.crewly\/logs\/skill-setup\/transcribe-audio\.log/);
		expect(msg).toMatch(/Do not retry the same install/);
	});

	it('returns already-ready without a job when the skill is installed and set up', async () => {
		const runner = fakeRunner();
		const svc = service({ discovery: fakeDiscovery([skill()], true), runner });
		const res = await svc.startInstall({ skillId: 'transcribe-audio', requesterSession: 'dev-1' });
		expect(res).toEqual({ kind: 'already-ready', skill: { id: 'transcribe-audio', executePath: '/pkg/config/skills/agent/transcribe-audio/execute.sh', officialReason: 'bundled with Crewly' } });
		expect(runner.calls).toEqual([]);
		expect(enqueued).toEqual([]);
	});

	it('re-runs setup with force even when ready', async () => {
		const svc = service({ discovery: fakeDiscovery([skill()], true) });
		expect((await svc.startInstall({ skillId: 'transcribe-audio', force: true })).kind).toBe('job');
	});

	it('joins a running job and notifies every requester once it ends', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runner = fakeRunner();
		const slow = { runSetup: jest.fn(async (i: RunSetupInput) => { await gate; return runner.runSetup(i); }) } as unknown as SkillSetupRunner;
		const svc = service({ discovery: fakeDiscovery([skill()]), runner: slow });
		const a = await svc.startInstall({ skillId: 'transcribe-audio', requesterSession: 'dev-1' });
		const b = await svc.startInstall({ skillId: 'transcribe-audio', requesterSession: 'qa-1' });
		expect(a.kind === 'job' && b.kind === 'job' && a.job.jobId === b.job.jobId).toBe(true);
		release();
		await svc.waitForJob('job1');
		expect(enqueued.map((m) => m.targetSession)).toEqual(['dev-1', 'qa-1']);
		expect(slow.runSetup).toHaveBeenCalledTimes(1);
	});

	it('downloads a registry skill with the marketplace installer, then uses its skill.json setup', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-job-'));
		fs.writeFileSync(path.join(tmp, 'skill.json'), JSON.stringify({ id: 'ocr-images', setup: manifest }));
		const item = { id: 'ocr-images', type: 'skill', name: 'OCR', version: '1.0.0' } as MarketplaceItem;
		const install = jest.fn(async (): Promise<MarketplaceOperationResult> => ({ success: true, message: 'Installed OCR v1.0.0' }));
		const runner = fakeRunner();
		const svc = service({
			discovery: fakeDiscovery([skill({ id: 'ocr-images', source: 'registry', installed: false, skillDir: undefined, executePath: undefined, manifest: undefined, registryItem: item, officialReason: 'published by Crewly Team in the official public registry' })]),
			runner,
			installMarketplaceItem: install,
			installPathFor: () => tmp,
		});
		await svc.startInstall({ skillId: 'ocr-images', requesterSession: 'dev-1' });
		const done = await svc.waitForJob('job1');
		expect(install).toHaveBeenCalledWith(item);
		expect(runner.calls[0]).toMatchObject({ skillDir: tmp, manifest });
		expect(done.state).toBe('succeeded');
		expect(done.executePath).toBe(path.join(tmp, 'execute.sh'));
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('falls back to the public registry copy when the premium archive fails', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-job-fb-'));
		const pub = { id: 'code-review', type: 'skill', name: 'Code Review', version: '1.0.0', assets: { archive: 'config/skills/agent/marketplace/code-review' } } as MarketplaceItem;
		const premium = { ...pub, assets: { archive: 'skills/code-review/code-review-1.0.0.tar.gz' }, fallback: pub } as MarketplaceItem;
		const install = jest.fn(async (i: MarketplaceItem): Promise<MarketplaceOperationResult> =>
			i === premium ? { success: false, message: 'Download failed: 404 Not Found' } : { success: true, message: 'Installed Code Review v1.0.0' });
		const svc = service({
			discovery: fakeDiscovery([skill({ id: 'code-review', source: 'registry', installed: false, skillDir: undefined, manifest: undefined, registryItem: premium })]),
			installMarketplaceItem: install,
			installPathFor: () => tmp,
		});
		await svc.startInstall({ skillId: 'code-review', requesterSession: 'dev-1' });
		const done = await svc.waitForJob('job1');
		expect(install.mock.calls.map((c) => c[0])).toEqual([premium, pub]);
		expect(done.state).toBe('succeeded');
		expect(done.log).toMatch(/404 Not Found; trying the public registry copy/);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('fails the job when the marketplace download fails', async () => {
		const item = { id: 'ocr-images', type: 'skill', name: 'OCR', version: '1.0.0' } as MarketplaceItem;
		const svc = service({
			discovery: fakeDiscovery([skill({ id: 'ocr-images', source: 'registry', installed: false, skillDir: undefined, registryItem: item })]),
			installMarketplaceItem: async () => ({ success: false, message: 'Download failed: 404 Not Found' }),
		});
		await svc.startInstall({ skillId: 'ocr-images', requesterSession: 'dev-1' });
		expect((await svc.waitForJob('job1')).message).toBe('marketplace install failed: Download failed: 404 Not Found');
		expect(enqueued[0].content).toMatch(/^\[SKILL INSTALL FAILED\] ocr-images/);
	});

	it('still runs without a requester, and without a queue it records notified=false', async () => {
		const svc = service({ discovery: fakeDiscovery([skill()]), enqueue: null });
		await svc.startInstall({ skillId: 'transcribe-audio', requesterSession: 'dev-1' });
		expect((await svc.waitForJob('job1')).notified).toBe(false);
	});

	it('rejects unknown skills and invalid setup blocks', async () => {
		const svc = service({ discovery: fakeDiscovery([skill({ id: 'bad', manifest: undefined, manifestError: 'setup.steps[0].type must be one of command, file, python' })]) });
		await expect(svc.startInstall({ skillId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
		await expect(svc.startInstall({ skillId: 'bad' })).rejects.toMatchObject({ code: 'invalid_setup' });
	});

	it('getJob throws job_not_found for unknown ids', () => {
		expect(() => service({ discovery: fakeDiscovery([]) }).getJob('x')).toThrow(SkillInstallError);
	});
});

describe('SkillInstallJobService — trust rule for third-party skills', () => {
	const shady = skill({ id: 'shady-ocr', name: 'Shady OCR', source: 'registry', official: false, officialReason: 'third-party: author "randomdev"', installed: false, skillDir: undefined, registryItem: { id: 'shady-ocr', type: 'skill', name: 'Shady OCR', version: '1.0.0' } as MarketplaceItem });

	it('refuses without approval and tells the agent to ask the owner', async () => {
		const svc = service({ discovery: fakeDiscovery([shady]) });
		const err = await svc.startInstall({ skillId: 'shady-ocr', requesterSession: 'dev-1' }).catch((e: SkillInstallError) => e);
		expect(err).toBeInstanceOf(SkillInstallError);
		expect((err as SkillInstallError).code).toBe('owner_approval_required');
		expect((err as SkillInstallError).message).toMatch(/third-party skill \(third-party: author "randomdev"\).*Ask the owner in chat.*--approved-by-owner/);
	});

	it('refuses --approved-by-owner when no owner message approves it', async () => {
		const svc = service({ discovery: fakeDiscovery([shady]), recentOwnerMessages: () => ['what are you doing?', 'should we install shady-ocr?'] });
		await expect(svc.startInstall({ skillId: 'shady-ocr', approvedByOwner: true })).rejects.toMatchObject({ code: 'owner_approval_not_found' });
	});

	it('fails closed when the owner chat cannot be read', async () => {
		const svc = service({
			discovery: fakeDiscovery([shady]),
			recentOwnerMessages: () => {
				throw new Error('SQLITE_BUSY');
			},
		});
		await expect(svc.startInstall({ skillId: 'shady-ocr', approvedByOwner: true })).rejects.toMatchObject({ code: 'owner_approval_unverifiable' });
	});

	it('installs with --approved-by-owner when the owner said yes, reading only the lookback window', async () => {
		const since: number[] = [];
		const svc = service({
			discovery: fakeDiscovery([shady]),
			installMarketplaceItem: async () => ({ success: true, message: 'ok' }),
			installPathFor: () => '/nonexistent',
			recentOwnerMessages: (s) => {
				since.push(s);
				return ['好的，装 shady-ocr'];
			},
			now: () => 10_000_000,
		});
		const res = await svc.startInstall({ skillId: 'shady-ocr', approvedByOwner: true, requesterSession: 'dev-1', ownerClaim: 'Steve said 好的，装 shady-ocr' });
		expect(res.kind).toBe('job');
		expect(since).toEqual([10_000_000 - 2 * 60 * 60 * 1000]);
		if (res.kind === 'job') {
			expect(res.job.log.startsWith('Third-party skill approved by the owner in chat: "好的，装 shady-ocr"\nThe agent cited: "Steve said 好的，装 shady-ocr"\n')).toBe(true);
		}
	});

	it('lets the owner install from the dashboard without chat evidence', async () => {
		const svc = service({ discovery: fakeDiscovery([shady]), installMarketplaceItem: async () => ({ success: true, message: 'ok' }), installPathFor: () => '/nonexistent' });
		expect((await svc.startInstall({ skillId: 'shady-ocr', ownerDashboard: true })).kind).toBe('job');
	});
});

describe('formatCompletionMessage', () => {
	it('omits empty sections', () => {
		const text = formatCompletionMessage(
			{ jobId: 'j', skillId: 's', state: 'succeeded', official: true, officialReason: '', estimatedMinutes: 1, startedAt: '', requesterSessions: [], log: '', notified: false },
			null,
			65_000,
		);
		expect(text).toBe('[SKILL INSTALLED] s is installed and ready (job j, 1m 5s).\nNext: tell the user in one line that it is ready, then do the task you paused — now, without waiting to be asked.');
	});
});
