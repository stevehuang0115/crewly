import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { OSS_BOUNDARY_CONSTANTS, PROCESS_EXIT_CODES } from '../../../config/index.js';
import {
	allowlistCovers,
	checkOssBoundary,
	extractImportSpecifiers,
	findPremiumSegments,
	forbiddenPackageFor,
	formatReport,
	parseAllowlist,
	runCli,
	stripComments,
	type AllowlistEntry,
	type BoundaryViolation,
} from './check-oss-boundary.js';

/**
 * Tests for the OSS/Pro boundary check (issue #809).
 *
 * Each rule gets a failing and a passing fixture built in a temp repo. The
 * forbidden package names are taken from the constants instead of being
 * written out, so this file never contains a real Pro import itself — the
 * last test runs the check over the real tree, including this file.
 */

const { RULES } = OSS_BOUNDARY_CONSTANTS;
const [PRO_PKG, SCOPED_PRO_PKG] = OSS_BOUNDARY_CONSTANTS.FORBIDDEN_IMPORT_PACKAGES;
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const REAL_TREE_TIMEOUT_MS = 60_000;

let repo: string;

/**
 * Writes a file into the temp repo, creating parent directories.
 *
 * @param relPath - Repository-relative path
 * @param content - File content; objects are JSON-encoded
 */
function put(relPath: string, content: string | object): void {
	const file = join(repo, relPath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/**
 * Runs the check on the temp repo with an explicit allowlist.
 *
 * @param allowlist - Exceptions to apply
 * @returns The unexcused violations
 */
function violations(allowlist: AllowlistEntry[] = []): BoundaryViolation[] {
	return checkOssBoundary(repo, allowlist).violations;
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'crewly-oss-boundary-'));
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('rule 1: paid requiredTier in config/templates', () => {
	it.each(['pro', 'enterprise', 'Enterprise'])('fails on requiredTier "%s"', (tier) => {
		put('config/templates/team-a.json', { name: 'A', requiredTier: tier });
		expect(violations()).toEqual([
			expect.objectContaining({ rule: RULES.PAID_TIER, path: 'config/templates/team-a.json' }),
		]);
	});

	it('fails on a nested declaration in a subdirectory', () => {
		put('config/templates/core-team/team.json', { roles: [{ name: 'dev', requiredTier: 'pro' }] });
		const [v] = violations();
		expect(v.rule).toBe(RULES.PAID_TIER);
		expect(v.detail).toContain('/roles/0/requiredTier');
	});

	it('passes on a free tier and on paid tiers outside config/templates', () => {
		put('config/templates/team-a.json', { name: 'A', requiredTier: 'free' });
		put('config/skills/x/skill.json', { requiredTier: 'pro' });
		expect(violations()).toEqual([]);
	});

	it('throws on a template that is not valid JSON', () => {
		put('config/templates/broken.json', '{ nope');
		expect(() => violations()).toThrow(/broken\.json is not valid JSON/);
	});
});

describe('rule 2: Pro-only template fields', () => {
	it.each(OSS_BOUNDARY_CONSTANTS.PRO_ONLY_TEMPLATE_FIELDS)('fails when a template defines "%s"', (field) => {
		put('config/templates/team-b.json', { name: 'B', [field]: [] });
		expect(violations()).toEqual([
			expect.objectContaining({ rule: RULES.PRO_TEMPLATE_FIELD, path: 'config/templates/team-b.json' }),
		]);
	});

	it('passes when the fields are absent at top level or appear in prose', () => {
		put('config/templates/team-b.json', {
			name: 'B',
			description: 'workflows and qualityGates live in Pro',
			roles: [{ workflows: 'nested, not a template field' }],
		});
		expect(violations()).toEqual([]);
	});
});

describe('rule 3: premium-looking paths under config/', () => {
	it.each([
		'config/templates/pro-sops/norms/onboarding.md',
		'config/skills/premium-thing/skill.json',
		'config/skills/examples/PREMIUM-example.json',
	])('fails on %s', (path) => {
		put(path, '{}');
		expect(violations()).toEqual([expect.objectContaining({ rule: RULES.PREMIUM_PATH, path })]);
	});

	it('passes on look-alikes that are not pro-/premium segments', () => {
		for (const path of [
			'config/prompts/system.md',
			'config/sops/process-review.md',
			'config/skills/improve-code/skill.json',
			'config/skills/approve-pr/skill.json',
			'config/roles/product-manager/prompt.md',
			'config/skills/pro.json',
		]) {
			put(path, '{}');
		}
		expect(violations()).toEqual([]);
	});

	it('ignores node_modules and dist and paths outside config/', () => {
		put('config/skills/x/node_modules/pro-dep/index.js', '');
		put('config/dist/premium.json', '{}');
		put('docs/premium-plan.md', '');
		expect(violations()).toEqual([]);
	});

	it('matches whole segments only', () => {
		expect(findPremiumSegments('config/templates/pro-sops/a.md')).toEqual(['pro-sops']);
		expect(findPremiumSegments('config/prompts/process-x/improve-y.md')).toEqual([]);
	});
});

describe('rule 4: Pro imports in OSS source', () => {
	it.each([
		['backend/src/a.ts', `import { x } from '${PRO_PKG}';`],
		['frontend/src/b.tsx', `import '${SCOPED_PRO_PKG}/styles';`],
		['cli/src/c.ts', `const m = await import("${PRO_PKG}/license");`],
		['mcp-server/src/d.ts', `export { y } from '${SCOPED_PRO_PKG}';`],
		['packages/chat-ui/src/e.ts', `const z = require('${PRO_PKG}');`],
	])('fails on %s', (path, source) => {
		put(path, source);
		expect(violations()).toEqual([expect.objectContaining({ rule: RULES.PRO_IMPORT, path })]);
	});

	it('passes on comments, plain strings, look-alike packages and skipped dirs', () => {
		put(
			'backend/src/ok.ts',
			[
				`// import { x } from '${PRO_PKG}';`,
				`/* const z = require('${PRO_PKG}'); */`,
				`export const ADDON_NAME = '${PRO_PKG}';`,
				`import { p } from '${PRO_PKG}col';`,
				`const url = 'https://example.com/a/*/b';`,
			].join('\n'),
		);
		put('backend/src/node_modules/x/index.ts', `import '${PRO_PKG}';`);
		put('packages/ui/dist/index.js', `import '${PRO_PKG}';`);
		put('scripts/tool.ts', `import '${PRO_PKG}';`);
		expect(violations()).toEqual([]);
	});

	it('extracts only real specifiers', () => {
		const source = `import a from 'a';\n// import b from 'b';\nexport * from "c";\nimport 'd';\nrequire( 'e' );`;
		expect(extractImportSpecifiers(source).sort()).toEqual(['a', 'c', 'd', 'e']);
		expect(stripComments('x /* y */ z')).toBe('x         z');
		expect(forbiddenPackageFor(`${SCOPED_PRO_PKG}/sub`)).toBe(SCOPED_PRO_PKG);
		expect(forbiddenPackageFor(`${PRO_PKG}-utils`)).toBeNull();
	});
});

describe('allowlist', () => {
	const entry: AllowlistEntry = {
		rule: RULES.PREMIUM_PATH,
		path: 'config/templates/pro-sops/',
		reason: 'pending owner decision on moving to crewly-pro (#809)',
	};

	it('excuses matching violations and reports stale entries', () => {
		put('config/templates/pro-sops/norms/a.md', '');
		const stale: AllowlistEntry = { ...entry, path: 'config/gone.json' };
		const report = checkOssBoundary(repo, [entry, stale]);
		expect(report.violations).toEqual([]);
		expect(report.allowed).toHaveLength(1);
		expect(report.unusedAllowlistEntries).toEqual([stale]);
		expect(formatReport(report)).toMatch(/^OK/);
	});

	it('only excuses the named rule and exact path or directory prefix', () => {
		const violation: BoundaryViolation = { rule: RULES.PAID_TIER, path: 'config/templates/pro-sops/t.json', detail: '' };
		expect(allowlistCovers(entry, violation)).toBe(false);
		expect(allowlistCovers({ ...entry, path: 'config/templates/pro' }, { ...violation, rule: RULES.PREMIUM_PATH })).toBe(false);
	});

	it.each([
		[{ entries: [{ rule: 'nope', path: 'a', reason: 'r' }] }, /unknown rule/],
		[{ entries: [{ rule: RULES.PREMIUM_PATH, path: '', reason: 'r' }] }, /non-empty "path"/],
		[{ entries: [{ rule: RULES.PREMIUM_PATH, path: 'a', reason: '' }] }, /one-line/],
		[{ entries: [{ rule: RULES.PREMIUM_PATH, path: 'a', reason: 'two\nlines' }] }, /one-line/],
		[[], /"entries" array/],
	])('rejects a malformed allowlist %#', (doc, message) => {
		expect(() => parseAllowlist(doc, 'allowlist.json')).toThrow(message);
	});
});

describe('runCli', () => {
	it('returns the error exit code and lists violations when the boundary is broken', () => {
		put('config/templates/team.json', { requiredTier: 'pro' });
		const errors: string[] = [];
		expect(runCli(repo, () => undefined, (m) => errors.push(m))).toBe(PROCESS_EXIT_CODES.ERROR);
		expect(errors.join('\n')).toContain('[paid-tier] config/templates/team.json');
	});

	it('returns success on a clean repo and reports a malformed allowlist as an error', () => {
		const logs: string[] = [];
		expect(runCli(repo, (m) => logs.push(m), () => undefined)).toBe(PROCESS_EXIT_CODES.SUCCESS);
		expect(logs[0]).toMatch(/^OK/);
		put(OSS_BOUNDARY_CONSTANTS.ALLOWLIST_FILE, { entries: 'x' });
		expect(runCli(repo, () => undefined, () => undefined)).toBe(PROCESS_EXIT_CODES.ERROR);
	});
});

describe('the real Crewly tree', () => {
	it(
		'has zero OSS/Pro boundary violations',
		() => {
			const report = checkOssBoundary(REPO_ROOT);
			expect(report.violations).toEqual([]);
		},
		REAL_TREE_TIMEOUT_MS,
	);
});
