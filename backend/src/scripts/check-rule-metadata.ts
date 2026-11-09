/**
 * Rule metadata check (issue #877).
 *
 * Every SOP under `config/sops/` is an accumulated rule in the agents' prompt
 * budget. Rules that record no failure cannot be judged later, and rules
 * written for one model may over-constrain the next. So each SOP's YAML
 * frontmatter carries three fields:
 *
 *  - `prevents`  — the concrete failure the rule stops (or "none recorded");
 *  - `seenOn`    — the model / harness where that failure was seen;
 *  - `reviewBy`  — the date (YYYY-MM-DD) by which the rule is re-tested:
 *                  switch it off for a sample of tasks, compare, delete it
 *                  when it makes no difference.
 *
 * This check reports coverage and fails when fewer than
 * {@link RULE_METADATA_CONSTANTS.MIN_COVERAGE} of the SOPs carry all three
 * (with a valid date). Overdue reviews and rules with no recorded failure
 * are listed as notes — they are the cleanup's work list, not an error.
 * Files without frontmatter are not SOPs to the loader and are reported as
 * skipped.
 *
 * Run with `npm run check:rule-metadata`; the jest suite also runs it
 * against the real tree (see `check-rule-metadata.test.ts`).
 *
 * @module backend/scripts/check-rule-metadata
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { extname, join, relative, sep } from 'path';
import { PROCESS_EXIT_CODES, RULE_METADATA_CONSTANTS } from '../../../config/index.js';

const F = RULE_METADATA_CONSTANTS.FIELDS;

/** One SOP file's metadata as the check read it. */
export interface RuleMetadata {
	/** Repository-relative path, `/` separators */
	path: string;
	/** `id` from the frontmatter, when present */
	id: string | null;
	prevents: string | null;
	seenOn: string | null;
	/** Raw `reviewBy` value */
	reviewBy: string | null;
	/** Fields missing or malformed; empty when the rule is fully described */
	missing: string[];
}

/** The whole report. */
export interface RuleMetadataReport {
	/** SOP files with frontmatter */
	rules: RuleMetadata[];
	/** Files under the SOP directory with no frontmatter block (not SOPs to the loader) */
	skipped: string[];
	/** Rules carrying all three fields, well-formed */
	covered: number;
	/** `covered / rules.length` (1 when there are no rules) */
	coverage: number;
	/** Rules whose `prevents` is the no-recorded-failure marker */
	noRecordedFailure: string[];
	/** Rules whose `reviewBy` date is before `today` */
	overdue: string[];
}

/**
 * The top-level scalar fields of a YAML frontmatter block, read with a
 * deliberately small parser: `key: value` lines at column 0. Lists and
 * nested maps are ignored — the three fields this check reads are scalars.
 *
 * @param source - The file's text
 * @returns The fields, or null when the file has no frontmatter block
 */
export function readFrontmatterScalars(source: string): Record<string, string> | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	if (!m) return null;
	const out: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (!kv) continue;
		let value = kv[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[kv[1]] = value;
	}
	return out;
}

/**
 * Whether a value is a calendar date written YYYY-MM-DD.
 *
 * @param value - The raw value
 * @returns True for a well-formed date
 */
export function isIsoDate(value: string | null): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const t = Date.parse(`${value}T00:00:00Z`);
	return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/**
 * Markdown files under a directory, recursively, sorted.
 *
 * @param dir - Absolute directory
 * @returns Absolute file paths
 */
export function listMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listMarkdownFiles(p));
		else if (extname(entry.name) === '.md') out.push(p);
	}
	return out.sort();
}

/**
 * Read one SOP file's rule metadata.
 *
 * @param repoRoot - Absolute repository root
 * @param file - Absolute file path
 * @returns Its metadata, or null when the file has no frontmatter
 */
export function readRuleMetadata(repoRoot: string, file: string): RuleMetadata | null {
	const fm = readFrontmatterScalars(readFileSync(file, 'utf8'));
	if (!fm) return null;
	const prevents = fm[F.PREVENTS]?.trim() || null;
	const seenOn = fm[F.SEEN_ON]?.trim() || null;
	const reviewBy = fm[F.REVIEW_BY]?.trim() || null;
	const missing: string[] = [];
	if (!prevents) missing.push(F.PREVENTS);
	if (!seenOn) missing.push(F.SEEN_ON);
	if (!reviewBy) missing.push(F.REVIEW_BY);
	else if (!isIsoDate(reviewBy)) missing.push(`${F.REVIEW_BY} (not YYYY-MM-DD: "${reviewBy}")`);
	return {
		path: relative(repoRoot, file).split(sep).join('/'),
		id: fm['id'] ?? null,
		prevents,
		seenOn,
		reviewBy,
		missing,
	};
}

/**
 * Check every SOP under the SOP directory.
 *
 * @param repoRoot - Absolute repository root
 * @param today - The day reviews are measured against (default: now)
 * @returns The report
 */
export function checkRuleMetadata(repoRoot: string, today: Date = new Date()): RuleMetadataReport {
	const rules: RuleMetadata[] = [];
	const skipped: string[] = [];
	for (const file of listMarkdownFiles(join(repoRoot, RULE_METADATA_CONSTANTS.SOPS_DIR))) {
		const meta = readRuleMetadata(repoRoot, file);
		if (meta) rules.push(meta);
		else skipped.push(relative(repoRoot, file).split(sep).join('/'));
	}
	const covered = rules.filter((r) => r.missing.length === 0).length;
	const todayKey = today.toISOString().slice(0, 10);
	return {
		rules,
		skipped,
		covered,
		coverage: rules.length === 0 ? 1 : covered / rules.length,
		noRecordedFailure: rules.filter((r) => r.prevents?.toLowerCase().startsWith(RULE_METADATA_CONSTANTS.NO_RECORDED_FAILURE)).map((r) => r.path),
		overdue: rules.filter((r) => isIsoDate(r.reviewBy) && r.reviewBy < todayKey).map((r) => r.path),
	};
}

/**
 * Whether the report passes: coverage at or above the minimum.
 *
 * @param report - The report
 * @returns True when it passes
 */
export function passes(report: RuleMetadataReport): boolean {
	return report.coverage >= RULE_METADATA_CONSTANTS.MIN_COVERAGE;
}

/**
 * Render the report for the terminal / CI log.
 *
 * @param report - The report
 * @returns Multi-line text; starts with "OK" or "FAIL"
 */
export function formatReport(report: RuleMetadataReport): string {
	const pct = `${Math.round(report.coverage * 100)}%`;
	const head = `${report.covered}/${report.rules.length} SOPs carry ${F.PREVENTS}/${F.SEEN_ON}/${F.REVIEW_BY} (${pct}; minimum ${Math.round(RULE_METADATA_CONSTANTS.MIN_COVERAGE * 100)}%, #877)`;
	const lines = [passes(report) ? `OK: ${head}.` : `FAIL: ${head}.`];
	for (const r of report.rules) {
		if (r.missing.length > 0) lines.push(`  [missing] ${r.path}: ${r.missing.join(', ')}`);
	}
	if (report.noRecordedFailure.length > 0) {
		lines.push(`  note: ${report.noRecordedFailure.length} rule(s) record no failure — first candidates for the switch-off-and-compare review:`);
		for (const p of report.noRecordedFailure) lines.push(`    ${p}`);
	}
	if (report.overdue.length > 0) {
		lines.push(`  note: ${report.overdue.length} review(s) overdue — switch the rule off for a sample of tasks, compare, keep or delete, then set a new ${F.REVIEW_BY}:`);
		for (const p of report.overdue) lines.push(`    ${p}`);
	}
	for (const p of report.skipped) lines.push(`  note: ${p} has no frontmatter — the SOP loader skips it; move it or give it a header.`);
	return lines.join('\n');
}

/**
 * CLI entry: checks the repository and reports.
 *
 * @param repoRoot - Absolute repository root
 * @param log - Sink for the passing report
 * @param error - Sink for the failing report or an error
 * @returns Process exit code
 */
export function runCli(
	repoRoot: string,
	log: (message: string) => void = (m) => console.log(m),
	error: (message: string) => void = (m) => console.error(m),
): number {
	try {
		const report = checkRuleMetadata(repoRoot);
		const text = formatReport(report);
		if (!passes(report)) {
			error(text);
			return PROCESS_EXIT_CODES.ERROR;
		}
		log(text);
		return PROCESS_EXIT_CODES.SUCCESS;
	} catch (err) {
		error(err instanceof Error ? err.message : String(err));
		return PROCESS_EXIT_CODES.ERROR;
	}
}

/* c8 ignore start — CLI entry, exercised by `npm run check:rule-metadata` */
const invokedDirectly =
	process.argv[1] !== undefined && /check-rule-metadata\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
	process.exitCode = runCli(process.cwd());
}
/* c8 ignore stop */
