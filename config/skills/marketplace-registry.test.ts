import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
	buildRegistry,
	listSkillFiles,
	SKILL_FILE_EXCLUDES,
	MARKETPLACE_SKILLS_REL_DIR,
	parseFrontmatter,
	readSkillManifest,
	type Registry,
} from './marketplace-registry.js';

/** Write files into a throwaway repo root: relative path -> contents. */
function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'mkt-registry-'));
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), body);
	}
	return root;
}

const M = MARKETPLACE_SKILLS_REL_DIR;
const skillMd = (fields: string) => `---\n${fields}\n---\n\n# Skill\n`;

describe('parseFrontmatter / readSkillManifest', () => {
	it('parses YAML frontmatter and returns null without one', () => {
		expect(parseFrontmatter(skillMd('name: A\nversion: 2.0.0'))).toEqual({ name: 'A', version: '2.0.0' });
		expect(parseFrontmatter('# no frontmatter')).toBeNull();
	});

	it('merges both manifests with SKILL.md winning field by field', () => {
		const root = fixture({
			'x/SKILL.md': skillMd('name: From MD\nversion: 1.2.0'),
			'x/skill.json': JSON.stringify({ id: 'agent-x', name: 'From JSON', category: 'quality' }),
		});
		try {
			expect(readSkillManifest(path.join(root, 'x'))).toEqual({
				id: 'agent-x',
				name: 'From MD',
				version: '1.2.0',
				category: 'quality',
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('listSkillFiles', () => {
	it('lists flat files only, sorted, without tests, mocks or .crewlyignore', () => {
		const root = fixture({
			'x/SKILL.md': '---\nname: X\n---\n',
			'x/generate.sh': 'echo\n',
			'x/.env.example': 'KEY=\n',
			'x/execute.test.sh': 'test\n',
			'x/mock-server.py': 'mock\n',
			'x/.crewlyignore': 'static/\n',
			'x/templates/A.tsx': 'nested\n',
		});
		try {
			expect(listSkillFiles(path.join(root, 'x'))).toEqual(['.env.example', 'generate.sh', 'SKILL.md']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('buildRegistry — setup blocks', () => {
	it('copies a skill.json setup block into metadata.setup, and leaves skills without one unchanged', () => {
		const setup = { estimatedMinutes: 2, steps: [{ id: 'ffmpeg', type: 'command', check: { commands: ['ffmpeg'] } }] };
		const root = fixture({
			[`${M}/with-setup/skill.json`]: JSON.stringify({ id: 'with-setup', name: 'With Setup', setup }),
			[`${M}/with-setup/execute.sh`]: 'echo\n',
			[`${M}/plain/SKILL.md`]: skillMd('name: Plain'),
		});
		try {
			const { registry } = buildRegistry(root, null, '2026-09-25T00:00:00.000Z');
			const byId = new Map(registry.items.map((i) => [i.id, i]));
			expect(byId.get('with-setup')?.metadata.setup).toEqual(setup);
			expect(byId.get('plain')?.metadata).not.toHaveProperty('setup');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('buildRegistry', () => {
	let root = '';
	beforeEach(() => {
		root = fixture({
			[`${M}/md-only/SKILL.md`]: skillMd('name: MD Only\nversion: 3.0.0\ncategory: communication'),
			[`${M}/md-only/execute.sh`]: 'echo hi\n',
			[`${M}/json-only/skill.json`]: JSON.stringify({ id: 'agent-json-only', name: 'JSON Only' }),
			[`${M}/empty/README.md`]: 'nothing\n',
			['config/skills/orchestrator/elsewhere/SKILL.md']: skillMd('name: Elsewhere'),
		});
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('lists SKILL.md-only and skill.json-only skills, and skips a dir with no manifest', () => {
		const { registry, skipped } = buildRegistry(root, null, 'T1');
		expect(registry.items.map((i) => [i.id, i.version, i.category, i.source])).toEqual([
			['json-only', '1.0.0', 'development', `${M}/json-only`],
			['md-only', '3.0.0', 'communication', `${M}/md-only`],
		]);
		expect(skipped).toEqual([{ dir: `${M}/empty`, reason: 'no SKILL.md frontmatter or skill.json' }]);
	});

	it('gives a NEW skill its directory name as id, not a legacy manifest id', () => {
		const { registry } = buildRegistry(root, null, 'T1');
		expect(registry.items.find((i) => i.source.endsWith('/json-only'))?.id).toBe('json-only');
	});

	it('keeps the published id of a skill the registry already lists', () => {
		const first = buildRegistry(root, null, 'T1').registry;
		const published: Registry = {
			...first,
			items: first.items.map((i) => (i.id === 'md-only' ? { ...i, id: 'agent-md-only' } : i)),
		};
		const { registry } = buildRegistry(root, published, 'T2');
		expect(registry.items.map((i) => i.id)).toEqual(['agent-md-only', 'json-only']);
	});

	it('keeps an entry listed from outside the marketplace dir, and reports one whose dir is gone', () => {
		const first = buildRegistry(root, null, 'T1').registry;
		const previous: Registry = {
			...first,
			items: [
				...first.items,
				{ ...first.items[0], id: 'elsewhere', source: 'config/skills/orchestrator/elsewhere', assets: { archive: 'config/skills/orchestrator/elsewhere', checksum: '', sizeBytes: 0 } },
				{ ...first.items[0], id: 'gone', source: 'config/skills/agent/gone', assets: { archive: 'config/skills/agent/gone', checksum: '', sizeBytes: 0 } },
			],
		};
		const { registry, skipped } = buildRegistry(root, previous, 'T2');
		expect(registry.items.map((i) => i.id)).toEqual(['elsewhere', 'json-only', 'md-only']);
		expect(skipped).toContainEqual({ dir: 'config/skills/agent/gone', reason: 'listed in the registry but the directory no longer exists' });
	});

	it('is idempotent: rebuilding against its own output changes nothing', () => {
		const first = buildRegistry(root, null, 'T1').registry;
		const second = buildRegistry(root, first, 'T2').registry;
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it('bumps updatedAt (and lastUpdated) only for an entry whose content changed', () => {
		const first = buildRegistry(root, null, 'T1').registry;
		writeFileSync(path.join(root, M, 'md-only', 'SKILL.md'), skillMd('name: MD Only\nversion: 3.1.0\ncategory: communication'));
		const second = buildRegistry(root, first, 'T2').registry;
		const byId = Object.fromEntries(second.items.map((i) => [i.id, i]));
		expect(byId['md-only'].version).toBe('3.1.0');
		expect(byId['md-only'].updatedAt).toBe('T2');
		expect(byId['md-only'].createdAt).toBe('T1');
		expect(byId['json-only'].updatedAt).toBe('T1');
		expect(second.lastUpdated).toBe('T2');
	});
});

describe('committed config/skills/registry.json', () => {
	const repoRoot = path.resolve(__dirname, '..', '..');
	const committed = JSON.parse(readFileSync(path.join(repoRoot, 'config', 'skills', 'registry.json'), 'utf-8')) as Registry;
	const dirs = readdirSync(path.join(repoRoot, M), { withFileTypes: true }).filter((e) => e.isDirectory());

	it(`is up to date with the skill sources (${dirs.length} marketplace dir(s) checked)`, () => {
		// An empty input set is an unknown result, not a pass.
		expect(dirs.length).toBeGreaterThan(0);
		const { registry, skipped } = buildRegistry(repoRoot, committed, committed.lastUpdated);
		expect(skipped).toEqual([]);
		// Fails when a skill was added, removed or edited without running
		// `npx tsx scripts/generate-registry.ts`.
		expect(registry).toEqual(committed);
	});

	it('lists every marketplace directory exactly once, with unique ids', () => {
		const ids = committed.items.map((i) => i.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const d of dirs) {
			expect(committed.items.filter((i) => i.source === `${M}/${d.name}`)).toHaveLength(1);
		}
	});

	it(`lists, for every source dir, exactly its flat files minus exclusions (${committed.items.length} dir(s) examined)`, () => {
		// Recomputed independently of the builder: the dir's regular files,
		// minus *.test.*, mock-* and .crewlyignore. Subdirectories never count.
		expect(committed.items.length).toBeGreaterThan(0);
		const mismatches: string[] = [];
		for (const item of committed.items) {
			const dir = path.join(repoRoot, item.source);
			const expected = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => e.name)
				.filter((n) => !n.includes('.test.') && !n.startsWith('mock-') && n !== '.crewlyignore')
				.sort((a, b) => a.localeCompare(b));
			const listed = item.metadata.files ?? [];
			if (JSON.stringify(listed) !== JSON.stringify(expected)) {
				mismatches.push(`${item.id}: listed ${JSON.stringify(listed)} expected ${JSON.stringify(expected)}`);
			}
		}
		expect(mismatches).toEqual([]);
		expect(SKILL_FILE_EXCLUDES.length).toBe(3);
	});

	it('never lists a nested path (older CLIs cannot create subdirectories)', () => {
		const nested = committed.items.flatMap((i) => (i.metadata.files ?? []).filter((f) => f.includes('/')).map((f) => `${i.id}: ${f}`));
		expect(nested).toEqual([]);
	});

	it('keeps the ids published docs tell users to install', () => {
		// Marketing's published posts (en + zh) run these exact commands.
		const ids = new Set(committed.items.map((i) => i.id));
		for (const id of ['code-review', 'nano-banana-image', 'agent-send-pdf-to-slack', 'playwright-chrome-browser']) {
			expect(ids.has(id)).toBe(true);
		}
		expect(ids.has('send-pdf-to-slack')).toBe(false);
	});
});
