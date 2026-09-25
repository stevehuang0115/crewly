import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MarketplaceItem } from '../../types/marketplace.types.js';
import {
	SkillDiscoveryService,
	expandTokens,
	registryOfficial,
	scoreSkill,
	tokenize,
} from './skill-discovery.service.js';
import type { SkillSetupRunner } from './skill-setup-runner.service.js';

/** Repo root (this file is four directories below it). */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REAL_BUNDLED = path.join(REPO_ROOT, 'config', 'skills', 'agent');

let tmp: string;

/**
 * Write a skill directory.
 *
 * @param root - Parent directory
 * @param dir - Directory name
 * @param skillJson - skill.json contents (optional)
 * @param frontmatter - SKILL.md frontmatter lines (optional)
 * @returns The skill directory
 */
function writeSkill(root: string, dir: string, skillJson?: Record<string, unknown>, frontmatter?: string): string {
	const skillDir = path.join(root, dir);
	fs.mkdirSync(skillDir, { recursive: true });
	if (skillJson) fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skillJson));
	if (frontmatter) fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# x\n`);
	fs.writeFileSync(path.join(skillDir, 'execute.sh'), 'echo {}\n');
	return skillDir;
}

/**
 * Minimal registry entry.
 *
 * @param over - Fields to override
 * @returns Entry
 */
function item(over: Partial<MarketplaceItem>): MarketplaceItem {
	return {
		id: 'x',
		type: 'skill',
		name: 'x',
		description: '',
		author: 'Crewly Team',
		version: '1.0.0',
		category: 'development',
		tags: [],
		license: 'MIT',
		downloads: 0,
		rating: 0,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		assets: {},
		registrySource: 'public',
		...over,
	} as MarketplaceItem;
}

/** Runner stub: check-only probe reports whatever `satisfied` says. */
function stubRunner(satisfied: boolean): SkillSetupRunner {
	return {
		runSetup: jest.fn(async ({ skillId, manifest }) => ({
			skillId,
			success: satisfied,
			checkOnly: true,
			logFile: '',
			durationMs: 0,
			steps: manifest.steps.map((s: { id: string; type: string }) => ({ id: s.id, type: s.type, status: satisfied ? 'satisfied' : 'missing', message: '', optional: false })),
		})),
	} as unknown as SkillSetupRunner;
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-discovery-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('tokenize / expandTokens', () => {
	it('drops stopwords and keeps CJK runs whole', () => {
		expect(tokenize('Transcribe a voice-message file (.m4a)')).toEqual(['transcribe', 'voice-message', 'm4a']);
		expect(tokenize('把语音转成文字')).toEqual(['把语音转成文字']);
	});

	it('adds synonyms at reduced weight, including CJK keys inside a token', () => {
		const expanded = expandTokens(['voice']);
		expect(expanded).toContainEqual({ token: 'voice', weight: 1 });
		expect(expanded).toContainEqual({ token: 'transcribe', weight: 0.6 });
		expect(expandTokens(['帮我听一下这段语音']).map((t) => t.token)).toContain('transcribe');
	});
});

describe('scoreSkill', () => {
	const audio = { id: 'transcribe-audio', name: 'transcribe-audio', tags: ['audio', 'voice', 'transcribe', 'm4a'], triggers: ['transcribe voice message'], description: 'Transcribe a local audio file with Whisper' };
	const pdf = { id: 'pdf-tools', name: 'pdf-tools', tags: ['pdf', 'read-pdf', 'merge'], triggers: ['read this pdf', 'make a pdf'], description: 'Make and read PDFs' };
	const slack = { id: 'send-pdf-to-slack', name: 'Send PDF to Slack', tags: ['slack', 'pdf'], triggers: ['pdf to slack'], description: 'Convert markdown to PDF and upload to Slack' };

	it('ranks the transcription skill first for a voice message', () => {
		const q = 'transcribe a Slack voice message (m4a audio clip)';
		expect(scoreSkill(q, audio)).toBeGreaterThan(scoreSkill(q, pdf));
		expect(scoreSkill(q, audio)).toBeGreaterThan(scoreSkill(q, slack));
	});

	it('ranks pdf-tools above send-pdf-to-slack for reading a PDF', () => {
		expect(scoreSkill('read this pdf', pdf)).toBeGreaterThan(scoreSkill('read this pdf', slack));
	});

	it('scores an exact id highest and unrelated skills zero', () => {
		expect(scoreSkill('pdf-tools', pdf)).toBeGreaterThanOrEqual(10);
		expect(scoreSkill('kubernetes deploy', audio)).toBe(0);
	});
});

describe('registryOfficial', () => {
	it('accepts Crewly authors in the public and premium registries', () => {
		expect(registryOfficial(item({ author: 'Crewly Team' })).official).toBe(true);
		expect(registryOfficial(item({ author: 'crewly', registrySource: 'premium' })).official).toBe(true);
	});

	it('accepts a verified flag', () => {
		expect(registryOfficial(item({ author: 'Acme', metadata: { verified: true } })).official).toBe(true);
	});

	it('rejects other authors, and anything from the local registry whatever it claims', () => {
		expect(registryOfficial(item({ author: 'Acme' }))).toEqual({ official: false, reason: 'third-party: author "Acme"' });
		const local = registryOfficial(item({ author: 'Crewly Team', registrySource: 'local' }));
		expect(local.official).toBe(false);
		expect(local.reason).toMatch(/published locally/);
		expect(registryOfficial(item({ author: 'Crewly Team', registrySource: undefined })).official).toBe(false);
	});
});

describe('SkillDiscoveryService.defaultBundledRoot', () => {
	it('finds <package>/config/skills/agent, anchored on the entry script as well as __dirname', () => {
		expect(SkillDiscoveryService.defaultBundledRoot()).toBe(REAL_BUNDLED);
		expect(SkillDiscoveryService.packageSearchStarts()).toContain(process.cwd());
		const argv1 = process.argv[1];
		expect(SkillDiscoveryService.packageSearchStarts().length).toBeGreaterThanOrEqual(argv1 ? 3 : 2);
	});
});

describe('SkillDiscoveryService', () => {
	const setup = { estimatedMinutes: 6, steps: [{ id: 'ffmpeg', type: 'command', check: { commands: ['ffmpeg'] } }] };

	function service(registry: MarketplaceItem[] | Error, satisfied = false, installedIds: string[] = []): SkillDiscoveryService {
		return new SkillDiscoveryService({
			bundledRoot: path.join(tmp, 'bundled'),
			installedRoot: path.join(tmp, 'installed'),
			fetchRegistry: async () => {
				if (registry instanceof Error) throw registry;
				return { schemaVersion: 2, lastUpdated: '', cdnBaseUrl: '', items: registry };
			},
			loadManifest: async () => ({ schemaVersion: 1, items: installedIds.map((id) => ({ id, type: 'skill', name: id, version: '1', installedAt: '', installPath: '' })) }),
			runner: stubRunner(satisfied),
		});
	}

	beforeEach(() => {
		const bundled = path.join(tmp, 'bundled');
		writeSkill(bundled, 'transcribe-audio', { id: 'transcribe-audio', name: 'transcribe-audio', tags: ['audio', 'voice', 'transcribe'], setup }, 'name: transcribe-audio\ndescription: Transcribe audio with Whisper\ntags:\n  - audio\n  - voice\n  - transcribe');
		writeSkill(path.join(bundled, 'core'), 'generate-pdf', undefined, 'name: Generate PDF\ndescription: Markdown to PDF\ntags:\n  - pdf');
		fs.mkdirSync(path.join(bundled, '_common'), { recursive: true });
		fs.writeFileSync(path.join(bundled, '_common', 'SKILL.md'), '---\nname: nope\n---\n');
	});

	it('finds a bundled skill with no registry at all, and reports its setup state', async () => {
		const { candidates, registryAvailable } = await service(new Error('offline')).find('voice message');
		expect(registryAvailable).toBe(false);
		expect(candidates[0]).toMatchObject({
			id: 'transcribe-audio',
			source: 'bundled',
			official: true,
			officialReason: 'bundled with Crewly',
			installed: true,
			ready: false,
			setup: { declared: true, estimatedMinutes: 6, satisfied: false, missing: ['ffmpeg'] },
		});
		expect(candidates[0].executePath).toBe(path.join(tmp, 'bundled', 'transcribe-audio', 'execute.sh'));
	});

	it('marks a bundled skill ready when its setup is satisfied', async () => {
		const { candidates } = await service([], true).find('transcribe');
		expect(candidates[0]).toMatchObject({ id: 'transcribe-audio', ready: true, setup: { satisfied: true, missing: [] } });
	});

	it('scans category directories and skips _common', async () => {
		const { candidates } = await service([]).find('pdf');
		expect(candidates.map((c) => c.id)).toEqual(['generate-pdf']);
		expect((await service([]).find('nope')).candidates).toEqual([]);
	});

	it('merges a registry entry into the bundled skill it describes (bundled wins)', async () => {
		const registry = [item({ id: 'agent-transcribe-audio', name: 'Transcribe', author: 'Someone', assets: { archive: 'config/skills/agent/transcribe-audio' } })];
		const { candidates } = await service(registry).find('transcribe');
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ id: 'transcribe-audio', source: 'bundled', official: true, registryId: 'agent-transcribe-audio' });
	});

	it('lists registry-only skills with the trust decision and declared setup', async () => {
		const registry = [
			item({ id: 'ocr-images', name: 'OCR', tags: ['ocr', 'image'], metadata: { setup: { estimatedMinutes: 2, steps: [{ id: 'tesseract', type: 'command', check: { commands: ['tesseract'] } }] } } }),
			item({ id: 'shady-ocr', name: 'Shady OCR', author: 'randomdev', tags: ['ocr'] }),
		];
		const { candidates } = await service(registry, false, ['ocr-images']).find('ocr');
		expect(candidates.map((c) => [c.id, c.official, c.installed])).toEqual([
			['ocr-images', true, true],
			['shady-ocr', false, false],
		]);
		expect(candidates[0].setup).toEqual({ declared: true, estimatedMinutes: 2 });
		expect(candidates[1].officialReason).toBe('third-party: author "randomdev"');
	});

	it('treats an installed marketplace skill as third-party once it leaves the official registry', async () => {
		writeSkill(path.join(tmp, 'installed'), 'mystery', { id: 'mystery', name: 'mystery', tags: ['mystery'] });
		const { candidates } = await service([]).find('mystery');
		expect(candidates[0]).toMatchObject({ id: 'mystery', source: 'installed', official: false });
	});

	it('resolves by id, registry id or directory name', async () => {
		const registry = [item({ id: 'agent-transcribe-audio', assets: { archive: 'config/skills/agent/transcribe-audio' } })];
		const svc = service(registry);
		expect((await svc.resolve('transcribe-audio'))?.id).toBe('transcribe-audio');
		expect((await svc.resolve('agent-transcribe-audio'))?.id).toBe('transcribe-audio');
		expect((await svc.resolve('generate-pdf'))?.id).toBe('generate-pdf');
		expect(await svc.resolve('does-not-exist')).toBeNull();
	});

	it('resolveLocal finds bundled and installed skills without fetching the registry', async () => {
		const fetchRegistry = jest.fn(async () => ({ schemaVersion: 2, lastUpdated: '', cdnBaseUrl: '', items: [] }));
		writeSkill(path.join(tmp, 'installed'), 'ocr-images', { id: 'ocr-images', name: 'ocr' });
		const svc = new SkillDiscoveryService({
			bundledRoot: path.join(tmp, 'bundled'),
			installedRoot: path.join(tmp, 'installed'),
			fetchRegistry,
			loadManifest: async () => ({ schemaVersion: 1, items: [] }),
			runner: stubRunner(true),
		});
		expect((await svc.resolveLocal('transcribe-audio'))?.source).toBe('bundled');
		expect((await svc.resolveLocal('ocr-images'))?.source).toBe('installed');
		expect(await svc.resolveLocal('nope')).toBeNull();
		expect(fetchRegistry).not.toHaveBeenCalled();
	});

	it('flags an invalid setup block instead of trusting it', async () => {
		writeSkill(path.join(tmp, 'bundled'), 'broken', { id: 'broken', name: 'broken', tags: ['broken'], setup: { steps: [{ id: 'x', type: 'npm' }] } });
		const resolved = await service([]).resolve('broken');
		expect(resolved?.manifest).toBeUndefined();
		expect(resolved?.manifestError).toMatch(/type must be one of/);
	});

	it('on the real bundled tree, ranks transcribe-audio and pdf-tools first for their needs', async () => {
		const svc = new SkillDiscoveryService({
			bundledRoot: REAL_BUNDLED,
			installedRoot: path.join(tmp, 'none'),
			fetchRegistry: async () => ({ schemaVersion: 2, lastUpdated: '', cdnBaseUrl: '', items: [] }),
			loadManifest: async () => ({ schemaVersion: 1, items: [] }),
			runner: stubRunner(true),
		});
		expect((await svc.find('transcribe a Slack voice message m4a', { probe: false })).candidates[0].id).toBe('transcribe-audio');
		expect((await svc.find('帮我听一下这段语音', { probe: false })).candidates[0].id).toBe('transcribe-audio');
		expect((await svc.find('read the text of a pdf the user sent', { probe: false })).candidates[0].id).toBe('pdf-tools');
		expect((await svc.find('merge several pdf parts into one', { probe: false })).candidates[0].id).toBe('pdf-tools');
	});
});
