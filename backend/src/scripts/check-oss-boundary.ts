/**
 * OSS/Pro boundary check (issue #809).
 *
 * CLAUDE.md Critical Rule 10 says premium/paid content never lives in the OSS
 * repo. This module turns that prose into a check that fails when:
 *
 *  1. `paid-tier` — a JSON file under `config/templates/` declares
 *     `requiredTier` of `pro` or `enterprise` (at any depth);
 *  2. `pro-template-field` — a JSON template under `config/templates/`
 *     defines a Pro-only top-level field (`workflows`,
 *     `verificationPipeline`, `qualityGates`);
 *  3. `premium-path` — a file path under `config/` has a segment starting
 *     with `pro-` or containing `premium` (so `prompt`, `process-` and
 *     `improve-` are not matched);
 *  4. `pro-import` — an OSS source file imports or requires `crewly-pro` or
 *     `@crewly/pro` (only real import/require specifiers count, never
 *     comments or prose).
 *
 * Exceptions live in `config/oss-boundary-allowlist.json`, one entry per
 * path with the rule it is exempt from and a one-line reason.
 *
 * Run locally or in CI with `npm run check:oss-boundary`; the jest suite also
 * runs it against the real tree (see `check-oss-boundary.test.ts`).
 *
 * @module backend/scripts/check-oss-boundary
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { extname, join, relative, sep } from 'path';

import { OSS_BOUNDARY_CONSTANTS, PROCESS_EXIT_CODES } from '../../../config/index.js';

/** Identifier of one of the four boundary rules */
export type OssBoundaryRule =
	(typeof OSS_BOUNDARY_CONSTANTS.RULES)[keyof typeof OSS_BOUNDARY_CONSTANTS.RULES];

/** A single breach of the OSS/Pro boundary */
export interface BoundaryViolation {
	/** Which rule was broken */
	rule: OssBoundaryRule;
	/** Repository-relative path, always with `/` separators */
	path: string;
	/** Human-readable explanation of what was found */
	detail: string;
}

/** An explicit, reasoned exception to one rule for one path */
export interface AllowlistEntry {
	/** Rule the path is exempt from */
	rule: OssBoundaryRule;
	/** Repository-relative path; a trailing `/` exempts everything below it */
	path: string;
	/** One-line reason the exception exists */
	reason: string;
}

/** Outcome of a boundary check */
export interface BoundaryReport {
	/** Violations not covered by the allowlist — any of these fails the check */
	violations: BoundaryViolation[];
	/** Violations excused by an allowlist entry */
	allowed: BoundaryViolation[];
	/** Allowlist entries that matched nothing (stale; reported, not fatal) */
	unusedAllowlistEntries: AllowlistEntry[];
}

const RULE_VALUES: readonly string[] = Object.values(OSS_BOUNDARY_CONSTANTS.RULES);

/**
 * Type guard for a rule identifier read from untrusted JSON.
 *
 * @param value - Candidate value
 * @returns true when the value names one of the four rules
 */
export function isOssBoundaryRule(value: unknown): value is OssBoundaryRule {
	return typeof value === 'string' && RULE_VALUES.includes(value);
}

/**
 * Converts a path relative to the repo root into `/`-separated form so
 * reports and allowlist entries look the same on every platform.
 *
 * @param repoRoot - Absolute repository root
 * @param absolutePath - Absolute path inside the repository
 * @returns The repository-relative POSIX path
 */
function toRepoPath(repoRoot: string, absolutePath: string): string {
	return relative(repoRoot, absolutePath).split(sep).join('/');
}

/**
 * Recursively lists every file below a directory, skipping `node_modules`,
 * `dist` and `.git`. A missing directory yields no files.
 *
 * @param dir - Absolute directory to walk
 * @returns Absolute file paths, sorted for stable output
 */
export function listFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const skipped: readonly string[] = OSS_BOUNDARY_CONSTANTS.SKIPPED_DIRS;
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!skipped.includes(entry.name)) {
				files.push(...listFiles(full));
			}
		} else if (entry.isFile()) {
			files.push(full);
		}
	}
	return files.sort();
}

/**
 * Parses a JSON template file.
 *
 * @param file - Absolute path of the JSON file
 * @param repoPath - Repository-relative path, used in the error message
 * @returns The parsed value
 * @throws Error when the file is not valid JSON — a broken template must not
 *   silently slip past the check
 */
function readJson(file: string, repoPath: string): unknown {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`check-oss-boundary: ${repoPath} is not valid JSON (${message})`);
	}
}

/**
 * Narrows an unknown value to a plain JSON object.
 *
 * @param value - Candidate value
 * @returns true when the value is a non-null, non-array object
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds every paid `requiredTier` declaration anywhere inside a JSON value.
 *
 * @param value - Parsed JSON
 * @param pointer - JSON pointer of `value` (empty for the document root)
 * @returns Human-readable descriptions of each paid-tier declaration
 */
export function findPaidTierDeclarations(value: unknown, pointer = ''): string[] {
	const paidTiers: readonly string[] = OSS_BOUNDARY_CONSTANTS.PAID_TIERS;
	const found: string[] = [];
	if (Array.isArray(value)) {
		value.forEach((item, index) => found.push(...findPaidTierDeclarations(item, `${pointer}/${index}`)));
	} else if (isJsonObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			const childPointer = `${pointer}/${key}`;
			if (
				key === OSS_BOUNDARY_CONSTANTS.TIER_FIELD &&
				typeof child === 'string' &&
				paidTiers.includes(child.toLowerCase())
			) {
				found.push(`${childPointer} is "${child}"`);
			}
			found.push(...findPaidTierDeclarations(child, childPointer));
		}
	}
	return found;
}

/**
 * Lists the Pro-only fields a template defines at its top level.
 *
 * @param value - Parsed template JSON
 * @returns Names of the Pro-only fields present
 */
export function findProOnlyTemplateFields(value: unknown): string[] {
	if (!isJsonObject(value)) {
		return [];
	}
	return OSS_BOUNDARY_CONSTANTS.PRO_ONLY_TEMPLATE_FIELDS.filter((field) => field in value);
}

/**
 * Returns the path segments that look like Pro or premium content: a segment
 * that starts with `pro-` or contains `premium` (case-insensitive). Whole
 * segments are tested so names like `prompt`, `process-` or `improve-` never
 * match.
 *
 * @param repoPath - `/`-separated path
 * @returns The offending segments, empty when the path is clean
 */
export function findPremiumSegments(repoPath: string): string[] {
	return repoPath.split('/').filter((segment) => {
		const lower = segment.toLowerCase();
		return (
			lower.startsWith(OSS_BOUNDARY_CONSTANTS.PRO_SEGMENT_PREFIX) ||
			lower.includes(OSS_BOUNDARY_CONSTANTS.PREMIUM_SEGMENT_MARKER)
		);
	});
}

/**
 * Blanks out comments in JS/TS source while keeping string literals, so
 * import specifiers can be matched without tripping on commented-out code
 * or prose. Quoted strings end at a newline, which bounds the damage a
 * regex literal containing a quote can do.
 *
 * @param source - Source text
 * @returns The source with every comment replaced by spaces
 */
export function stripComments(source: string): string {
	let out = '';
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === '/' && next === '/') {
			while (i < source.length && source[i] !== '\n') {
				out += ' ';
				i++;
			}
		} else if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2);
			const stop = end === -1 ? source.length : end + 2;
			out += source.slice(i, stop).replace(/[^\n]/g, ' ');
			i = stop;
		} else if (ch === '"' || ch === "'" || ch === '`') {
			let j = i + 1;
			while (j < source.length && source[j] !== ch && (ch === '`' || source[j] !== '\n')) {
				j += source[j] === '\\' ? 2 : 1;
			}
			const stop = Math.min(j + 1, source.length);
			out += source.slice(i, stop);
			i = stop;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

/** Patterns whose first capture group is a module specifier */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
	// import x from '…' / export { x } from '…' / import type { T } from '…'
	/\bfrom\s*(['"])([^'"\n]+)\1/g,
	// import '…' (side-effect import)
	/\bimport\s*(['"])([^'"\n]+)\1/g,
	// import('…') (dynamic import) and require('…')
	/\b(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
];

/**
 * Extracts the module specifiers a source file imports or requires.
 *
 * @param source - JS/TS source text
 * @returns Every specifier found, in order of appearance per pattern
 *
 * @example
 * ```typescript
 * extractImportSpecifiers("import a from 'x'; const b = require('y');"); // ['x', 'y']
 * ```
 */
export function extractImportSpecifiers(source: string): string[] {
	const code = stripComments(source);
	const specifiers: string[] = [];
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of code.matchAll(pattern)) {
			specifiers.push(match[2]);
		}
	}
	return specifiers;
}

/**
 * Tells whether a specifier names a forbidden Pro package or one of its
 * subpaths (e.g. `crewly-pro/dist/x`). Look-alikes such as `crewly-protocol`
 * do not match.
 *
 * @param specifier - Module specifier
 * @returns The forbidden package name, or null
 */
export function forbiddenPackageFor(specifier: string): string | null {
	for (const pkg of OSS_BOUNDARY_CONSTANTS.FORBIDDEN_IMPORT_PACKAGES) {
		if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
			return pkg;
		}
	}
	return null;
}

/**
 * Rules 1 and 2: scans JSON under `config/templates/`.
 *
 * @param repoRoot - Absolute repository root
 * @returns Paid-tier and Pro-only-field violations
 * @throws Error when a template file is not valid JSON
 */
export function checkTemplates(repoRoot: string): BoundaryViolation[] {
	const violations: BoundaryViolation[] = [];
	const files = listFiles(join(repoRoot, OSS_BOUNDARY_CONSTANTS.TEMPLATES_DIR)).filter(
		(file) => extname(file) === OSS_BOUNDARY_CONSTANTS.JSON_EXTENSION,
	);
	for (const file of files) {
		const repoPath = toRepoPath(repoRoot, file);
		const json = readJson(file, repoPath);
		for (const declaration of findPaidTierDeclarations(json)) {
			violations.push({
				rule: OSS_BOUNDARY_CONSTANTS.RULES.PAID_TIER,
				path: repoPath,
				detail: `paid tier declared: ${declaration}`,
			});
		}
		for (const field of findProOnlyTemplateFields(json)) {
			violations.push({
				rule: OSS_BOUNDARY_CONSTANTS.RULES.PRO_TEMPLATE_FIELD,
				path: repoPath,
				detail: `Pro-only template field "${field}"`,
			});
		}
	}
	return violations;
}

/**
 * Rule 3: scans every file path under `config/` for Pro/premium segments.
 *
 * @param repoRoot - Absolute repository root
 * @returns Premium-path violations
 */
export function checkConfigPaths(repoRoot: string): BoundaryViolation[] {
	const violations: BoundaryViolation[] = [];
	for (const file of listFiles(join(repoRoot, OSS_BOUNDARY_CONSTANTS.CONFIG_DIR))) {
		const repoPath = toRepoPath(repoRoot, file);
		const segments = findPremiumSegments(repoPath);
		if (segments.length > 0) {
			violations.push({
				rule: OSS_BOUNDARY_CONSTANTS.RULES.PREMIUM_PATH,
				path: repoPath,
				detail: `premium-looking path segment(s): ${segments.join(', ')}`,
			});
		}
	}
	return violations;
}

/**
 * Lists the source roots rule 4 scans: the fixed roots plus each workspace
 * package's `src` directory.
 *
 * @param repoRoot - Absolute repository root
 * @returns Absolute directories (some may not exist; those scan as empty)
 */
export function sourceRoots(repoRoot: string): string[] {
	const roots = OSS_BOUNDARY_CONSTANTS.SOURCE_ROOTS.map((root) => join(repoRoot, root));
	const packagesDir = join(repoRoot, OSS_BOUNDARY_CONSTANTS.PACKAGES_DIR);
	if (existsSync(packagesDir)) {
		for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				roots.push(join(packagesDir, entry.name, OSS_BOUNDARY_CONSTANTS.PACKAGE_SOURCE_SUBDIR));
			}
		}
	}
	return roots;
}

/**
 * Rule 4: scans OSS source for imports of the Pro package.
 *
 * @param repoRoot - Absolute repository root
 * @returns Pro-import violations
 */
export function checkSourceImports(repoRoot: string): BoundaryViolation[] {
	const extensions: readonly string[] = OSS_BOUNDARY_CONSTANTS.SOURCE_EXTENSIONS;
	const violations: BoundaryViolation[] = [];
	for (const root of sourceRoots(repoRoot)) {
		for (const file of listFiles(root).filter((f) => extensions.includes(extname(f)))) {
			for (const specifier of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
				const pkg = forbiddenPackageFor(specifier);
				if (pkg !== null) {
					violations.push({
						rule: OSS_BOUNDARY_CONSTANTS.RULES.PRO_IMPORT,
						path: toRepoPath(repoRoot, file),
						detail: `imports "${specifier}" (${pkg} is the paid extension; OSS must not depend on it)`,
					});
				}
			}
		}
	}
	return violations;
}

/**
 * Validates the parsed allowlist document.
 *
 * @param value - Parsed allowlist JSON
 * @param source - Where it came from, for error messages
 * @returns The validated entries
 * @throws Error when the document is not `{ "entries": [...] }` or an entry
 *   lacks a known rule, a path or a non-empty one-line reason
 */
export function parseAllowlist(value: unknown, source: string): AllowlistEntry[] {
	if (!isJsonObject(value) || !Array.isArray(value.entries)) {
		throw new Error(`check-oss-boundary: ${source} must be an object with an "entries" array`);
	}
	return value.entries.map((entry: unknown, index: number): AllowlistEntry => {
		const where = `${source} entries[${index}]`;
		if (!isJsonObject(entry)) {
			throw new Error(`check-oss-boundary: ${where} must be an object`);
		}
		const { rule, path, reason } = entry;
		if (!isOssBoundaryRule(rule)) {
			throw new Error(`check-oss-boundary: ${where} has unknown rule ${JSON.stringify(rule)}; expected one of ${RULE_VALUES.join(', ')}`);
		}
		if (typeof path !== 'string' || path.trim() === '') {
			throw new Error(`check-oss-boundary: ${where} needs a non-empty "path"`);
		}
		if (typeof reason !== 'string' || reason.trim() === '' || reason.includes('\n')) {
			throw new Error(`check-oss-boundary: ${where} needs a one-line, non-empty "reason"`);
		}
		return { rule, path, reason };
	});
}

/**
 * Loads the allowlist from the repository. A missing file means no
 * exceptions.
 *
 * @param repoRoot - Absolute repository root
 * @returns The validated entries
 * @throws Error when the file exists but is malformed
 */
export function loadAllowlist(repoRoot: string): AllowlistEntry[] {
	const file = join(repoRoot, OSS_BOUNDARY_CONSTANTS.ALLOWLIST_FILE);
	if (!existsSync(file)) {
		return [];
	}
	return parseAllowlist(readJson(file, OSS_BOUNDARY_CONSTANTS.ALLOWLIST_FILE), OSS_BOUNDARY_CONSTANTS.ALLOWLIST_FILE);
}

/**
 * Tells whether an allowlist entry excuses a violation: same rule, and the
 * path matches exactly or sits below an entry path ending in `/`.
 *
 * @param entry - Allowlist entry
 * @param violation - Violation to test
 * @returns true when the entry covers the violation
 */
export function allowlistCovers(entry: AllowlistEntry, violation: BoundaryViolation): boolean {
	if (entry.rule !== violation.rule) {
		return false;
	}
	return entry.path.endsWith('/') ? violation.path.startsWith(entry.path) : entry.path === violation.path;
}

/**
 * Runs all four rules against a repository and applies the allowlist.
 *
 * @param repoRoot - Absolute repository root
 * @param allowlist - Exceptions; defaults to the repository's allowlist file
 * @returns Unexcused violations, excused ones and stale allowlist entries
 * @throws Error when a template or the allowlist is malformed JSON
 *
 * @example
 * ```typescript
 * const report = checkOssBoundary(process.cwd());
 * if (report.violations.length > 0) process.exit(1);
 * ```
 */
export function checkOssBoundary(
	repoRoot: string,
	allowlist: AllowlistEntry[] = loadAllowlist(repoRoot),
): BoundaryReport {
	const all = [...checkTemplates(repoRoot), ...checkConfigPaths(repoRoot), ...checkSourceImports(repoRoot)];
	const used = new Set<AllowlistEntry>();
	const violations: BoundaryViolation[] = [];
	const allowed: BoundaryViolation[] = [];
	for (const violation of all) {
		const entry = allowlist.find((candidate) => allowlistCovers(candidate, violation));
		if (entry) {
			used.add(entry);
			allowed.push(violation);
		} else {
			violations.push(violation);
		}
	}
	return {
		violations,
		allowed,
		unusedAllowlistEntries: allowlist.filter((entry) => !used.has(entry)),
	};
}

/**
 * Renders a report for the terminal / CI log.
 *
 * @param report - Result of {@link checkOssBoundary}
 * @returns Multi-line text; starts with "OK" or "FAIL"
 */
export function formatReport(report: BoundaryReport): string {
	const lines: string[] = [];
	if (report.violations.length === 0) {
		lines.push(`OK: OSS/Pro boundary holds (${report.allowed.length} allowlisted exception(s)).`);
	} else {
		lines.push(`FAIL: ${report.violations.length} OSS/Pro boundary violation(s) — premium content belongs in crewly-pro (CLAUDE.md rule 10, #809):`);
		for (const v of report.violations) {
			lines.push(`  [${v.rule}] ${v.path}: ${v.detail}`);
		}
		lines.push(`Move the content to crewly-pro, or add an entry with a one-line reason to ${OSS_BOUNDARY_CONSTANTS.ALLOWLIST_FILE}.`);
	}
	for (const entry of report.unusedAllowlistEntries) {
		lines.push(`  note: allowlist entry [${entry.rule}] ${entry.path} matched nothing — remove it once the owner confirms.`);
	}
	return lines.join('\n');
}

/**
 * CLI entry: checks the repository and reports.
 *
 * @param repoRoot - Absolute repository root
 * @param log - Sink for the passing report
 * @param error - Sink for the failing report or a malformed-input error
 * @returns Process exit code: success when no unexcused violations
 */
export function runCli(
	repoRoot: string,
	log: (message: string) => void = (m) => console.log(m),
	error: (message: string) => void = (m) => console.error(m),
): number {
	try {
		const report = checkOssBoundary(repoRoot);
		const text = formatReport(report);
		if (report.violations.length > 0) {
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

/* c8 ignore start — CLI entry, exercised by `npm run check:oss-boundary` */
const invokedDirectly =
	process.argv[1] !== undefined && /check-oss-boundary\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
	process.exitCode = runCli(process.cwd());
}
/* c8 ignore stop */
