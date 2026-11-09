import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PROCESS_EXIT_CODES, RULE_METADATA_CONSTANTS } from '../../../config/index.js';
import {
	checkRuleMetadata,
	formatReport,
	isIsoDate,
	passes,
	readFrontmatterScalars,
	runCli,
} from './check-rule-metadata.js';

/**
 * Tests for the rule metadata check (issue #877): frontmatter reading, the
 * coverage rule, the notes, and a run against the real `config/sops/`.
 */

const TODAY = new Date('2026-10-23T12:00:00Z');

/**
 * A SOP file with the given frontmatter lines.
 *
 * @param lines - Frontmatter lines (without the fences)
 * @param body - Markdown body
 * @returns File text
 */
function sop(lines: string[], body = '# Rule\n\nDo the thing.\n'): string {
	return ['---', ...lines, '---', '', body].join('\n');
}

const BASE = ['id: x', 'version: 1', 'role: all', 'category: process', 'priority: 5', 'title: X', 'description: d', 'triggers:', '  - x', 'tags: []'];

describe('readFrontmatterScalars', () => {
	it('reads top-level scalars, strips quotes, ignores lists and nested keys', () => {
		const fm = readFrontmatterScalars(sop([...BASE, 'prevents: "Agents shipped silently"', "reviewBy: '2027-01-31'", 'nested:', '  deep: 1']));
		expect(fm).toMatchObject({ id: 'x', prevents: 'Agents shipped silently', reviewBy: '2027-01-31' });
		expect(fm).not.toHaveProperty('deep');
		expect(fm).not.toHaveProperty('- x');
	});

	it('returns null for a file without a frontmatter block', () => {
		expect(readFrontmatterScalars('# Policy\n\nNo header here.\n')).toBeNull();
		expect(readFrontmatterScalars('---\nunterminated: yes\n')).toBeNull();
	});
});

describe('isIsoDate', () => {
	it.each(['2026-10-23', '2027-01-31'])('accepts %s', (d) => expect(isIsoDate(d)).toBe(true));
	it.each([null, '', '2026-13-01', '2026-02-30', '23/10/2026', 'soon'])('rejects %j', (d) => expect(isIsoDate(d as string | null)).toBe(false));
});

describe('checkRuleMetadata', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'rule-meta-'));
		mkdirSync(join(root, RULE_METADATA_CONSTANTS.SOPS_DIR, 'common'), { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/**
	 * @param name - File name under config/sops/common
	 * @param text - File text
	 */
	function write(name: string, text: string): void {
		writeFileSync(join(root, RULE_METADATA_CONSTANTS.SOPS_DIR, 'common', name), text);
	}

	it('counts covered rules, lists missing fields, notes no-failure rules, overdue reviews and header-less files', () => {
		write('full.md', sop([...BASE, 'prevents: Owner-facing messages leaked task ids', 'seenOn: claude-code 2026-05', 'reviewBy: 2027-01-31']));
		write('library.md', sop([...BASE, `prevents: ${RULE_METADATA_CONSTANTS.NO_RECORDED_FAILURE} — default library`, 'seenOn: unknown', 'reviewBy: 2026-06-30']));
		write('partial.md', sop([...BASE, 'prevents: something', 'reviewBy: next quarter']));
		write('policy.md', '# Policy\n\nNo frontmatter.\n');

		const report = checkRuleMetadata(root, TODAY);
		expect(report.rules.map((r) => r.path)).toEqual([
			'config/sops/common/full.md',
			'config/sops/common/library.md',
			'config/sops/common/partial.md',
		]);
		expect(report.skipped).toEqual(['config/sops/common/policy.md']);
		expect(report.covered).toBe(2);
		expect(report.coverage).toBeCloseTo(2 / 3);
		expect(report.rules[2].missing).toEqual(['seenOn', 'reviewBy (not YYYY-MM-DD: "next quarter")']);
		expect(report.noRecordedFailure).toEqual(['config/sops/common/library.md']);
		expect(report.overdue).toEqual(['config/sops/common/library.md']);
		expect(passes(report)).toBe(false);

		const text = formatReport(report);
		expect(text).toMatch(/^FAIL: 2\/3 SOPs carry prevents\/seenOn\/reviewBy \(67%; minimum 80%, #877\)\./);
		expect(text).toContain('[missing] config/sops/common/partial.md: seenOn, reviewBy (not YYYY-MM-DD: "next quarter")');
		expect(text).toContain('1 rule(s) record no failure');
		expect(text).toContain('1 review(s) overdue');
		expect(text).toContain('config/sops/common/policy.md has no frontmatter');
	});

	it('passes at or above the minimum coverage, and with no SOPs at all', () => {
		for (let i = 0; i < 4; i++) write(`r${i}.md`, sop([...BASE, 'prevents: p', 'seenOn: s', 'reviewBy: 2027-01-31']));
		write('r4.md', sop([...BASE, 'prevents: p']));
		const report = checkRuleMetadata(root, TODAY);
		expect(report.coverage).toBe(0.8);
		expect(passes(report)).toBe(true);
		expect(formatReport(report)).toMatch(/^OK: 4\/5 SOPs/);

		rmSync(join(root, RULE_METADATA_CONSTANTS.SOPS_DIR), { recursive: true, force: true });
		const empty = checkRuleMetadata(root, TODAY);
		expect(empty.rules).toEqual([]);
		expect(empty.coverage).toBe(1);
		expect(passes(empty)).toBe(true);
	});

	it('runCli exits non-zero on a failing report and zero on a passing one', () => {
		const logs: string[] = [];
		const errors: string[] = [];
		write('bare.md', sop(BASE));
		expect(runCli(root, (m) => logs.push(m), (m) => errors.push(m))).toBe(PROCESS_EXIT_CODES.ERROR);
		expect(errors[0]).toMatch(/^FAIL/);

		write('bare.md', sop([...BASE, 'prevents: p', 'seenOn: s', 'reviewBy: 2027-01-31']));
		expect(runCli(root, (m) => logs.push(m), (m) => errors.push(m))).toBe(PROCESS_EXIT_CODES.SUCCESS);
		expect(logs[0]).toMatch(/^OK/);
	});
});

describe('the real config/sops tree', () => {
	const repoRoot = resolve(process.cwd());
	const hasTree = existsSync(join(repoRoot, RULE_METADATA_CONSTANTS.SOPS_DIR));

	(hasTree ? it : it.skip)('meets the coverage minimum', () => {
		const report = checkRuleMetadata(repoRoot);
		expect(formatReport(report)).toMatch(/^OK/);
		expect(passes(report)).toBe(true);
	});
});
