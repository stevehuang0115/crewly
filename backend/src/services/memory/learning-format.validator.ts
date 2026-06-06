/**
 * Learning format validator (Karpathy-lite / Entity-Centric)
 *
 * Implements the 4-rule preflight defined by ARCHIVIST-V2.f1
 * (`.crewly/tasks/autonomy_v1/follow-up/archivist-v2-record-learning-preflight.md`).
 *
 * Rules:
 *   1. Entity opener — text MUST start with `[[Entity Name]]` (one bracketed token).
 *   2. Sentence count — 1..3 sentences (split on `[.!?]+\s+`, filter empties).
 *   3. Linked or sourced — at minimum one of:
 *        - a second `[[Entity]]` link, OR
 *        - a `PR #...`, `Task #...`, `Issue #...`, `#NNN`, `Ref:`, `See:`, `Log:` source citation.
 *   4. No log-style anti-pattern — soft check: warn (don't reject) if text begins
 *      with a personal pronoun ("I fixed", "I tried", "We added", etc.).
 *
 * Default mode (`strict: false`):
 *   - Rule 1 → hard error (the entity opener is the joinability hook for
 *     Archivist v2 cross-doc synthesis; without it the learning has no anchor).
 *   - Rules 2..4 → soft warnings (accept the learning, surface the violation).
 *
 * Strict mode (`strict: true`):
 *   - All 4 rules emit hard errors. Used by CI / Archivist v2 callers that
 *     enforce full conformance.
 *
 * Lax-by-controller policy (v1.5 / convention-only):
 *   The controller wiring is deferred. The validator is shipped as a
 *   reusable utility so callers (CLI, tests, future Archivist v2 synthesizer,
 *   future controller integration) can opt into enforcement as needed.
 *   See `archivist-v2-record-learning-preflight.md` § Validator behavior and
 *   the orc note ("Convention-only enforcement is OK in v1.5").
 *
 * @module services/memory/learning-format.validator
 */

/** A single rule violation produced by {@link validateLearningFormat}. */
export interface LearningValidationIssue {
	/** Numeric rule id (1..4) */
	rule: 1 | 2 | 3 | 4;
	/** Stable machine-readable rule name */
	ruleName: 'entity_opener' | 'sentence_count' | 'linked_or_sourced' | 'no_log_style';
	/** Human-readable description of the violation */
	message: string;
	/** Optional suggested fix (entity opener / shortening / link insertion) */
	suggestion?: string;
	/** Pointer to the SKILL.md mandate section */
	skillRef: string;
}

/** Result returned by {@link validateLearningFormat}. */
export interface LearningValidationResult {
	/** True when no errors (warnings are not failure). */
	pass: boolean;
	/** Hard violations — caller MUST reject when `pass === false`. */
	errors: LearningValidationIssue[];
	/** Soft violations — caller SHOULD log/surface but MAY accept. */
	warnings: LearningValidationIssue[];
}

/** Options for {@link validateLearningFormat}. */
export interface LearningValidationOptions {
	/**
	 * When true, escalate all soft warnings (rules 2..4) to hard errors.
	 * Rule 1 is always a hard error regardless of this flag.
	 * @default false
	 */
	strict?: boolean;
}

/** Pointer used in all rejection messages so agents can self-correct. */
const SKILL_REF =
	'config/skills/agent/core/record-learning/SKILL.md § Mandated Format: Karpathy-lite';

/** Regex for rule 1: leading `[[Entity Name]]` token. */
const ENTITY_OPENER_RE = /^\[\[[^\]]+\]\]/;

/** Regex used to split a learning into rough sentences. */
const SENTENCE_SPLIT_RE = /[.!?]+\s+/;

/**
 * Pronoun openers that flag log-style (rule 4).
 * Case-insensitive match against the trimmed text.
 */
const LOG_STYLE_OPENERS = [
	/^i\s/i, // "I tried..."
	/^i'/i, // "I've", "I'm", "I'll"
	/^i,/i, // "I, ..."
	/^we\s/i, // "We added..."
	/^we'/i, // "We've", "We'll"
];

/**
 * Validate a learning text against the Karpathy-lite format rules.
 *
 * @param rawText - The learning text submitted to `record-learning`.
 * @param options - Validator options ({@link LearningValidationOptions}).
 * @returns A {@link LearningValidationResult} with errors and warnings split.
 *
 * @example
 * ```typescript
 * const result = validateLearningFormat('I fixed the bug today', { strict: false });
 * // → { pass: false, errors: [<rule 1>], warnings: [<rule 3>, <rule 4>] }
 * ```
 *
 * @example
 * ```typescript
 * const result = validateLearningFormat(
 *   '[[Fts5IndexService]] FTS5 rank is negative; invert. PR #320',
 *   { strict: true }
 * );
 * // → { pass: true, errors: [], warnings: [] }
 * ```
 */
export function validateLearningFormat(
	rawText: string,
	options: LearningValidationOptions = {}
): LearningValidationResult {
	const strict = options.strict === true;
	const errors: LearningValidationIssue[] = [];
	const warnings: LearningValidationIssue[] = [];

	const text = (rawText ?? '').trim();

	// Rule 1 — Entity opener (always hard).
	const entityMatch = text.match(ENTITY_OPENER_RE);
	if (!entityMatch) {
		errors.push({
			rule: 1,
			ruleName: 'entity_opener',
			message: 'Missing leading [[Entity]] opener — required for Archivist v2 join key.',
			suggestion: buildEntityOpenerSuggestion(text),
			skillRef: SKILL_REF,
		});
	}

	// Rule 2 — Sentence count (1..3).
	const sentenceCount = countSentences(text);
	if (sentenceCount > 3) {
		const issue: LearningValidationIssue = {
			rule: 2,
			ruleName: 'sentence_count',
			message: `Too many sentences (${sentenceCount}); Karpathy-lite caps at 3.`,
			suggestion: 'Trim to the single insight. Compress supporting context to a clause.',
			skillRef: SKILL_REF,
		};
		(strict ? errors : warnings).push(issue);
	} else if (sentenceCount < 1) {
		const issue: LearningValidationIssue = {
			rule: 2,
			ruleName: 'sentence_count',
			message: 'No sentences detected — text appears empty or fragmentary.',
			suggestion: 'Provide at least one full sentence describing the insight.',
			skillRef: SKILL_REF,
		};
		(strict ? errors : warnings).push(issue);
	}

	// Rule 3 — Linked or sourced.
	if (!hasLinkOrSource(text, entityMatch?.[0])) {
		const issue: LearningValidationIssue = {
			rule: 3,
			ruleName: 'linked_or_sourced',
			message:
				'Missing related-entity link or source citation — needs a second [[Entity]] OR PR/Task/Issue/Log reference.',
			suggestion:
				'Add a related [[Entity]] link OR a citation like "PR #123", "Task #abc", "Ref: <path>".',
			skillRef: SKILL_REF,
		};
		(strict ? errors : warnings).push(issue);
	}

	// Rule 4 — Log-style anti-pattern (always soft per spec, escalated under strict).
	if (looksLogStyle(text)) {
		const issue: LearningValidationIssue = {
			rule: 4,
			ruleName: 'no_log_style',
			message: 'Log-style opener detected ("I ..."/"We ..."). Rewrite entity-first.',
			suggestion:
				'Lead with [[Entity]] then state the insight. Avoid first-person narrative.',
			skillRef: SKILL_REF,
		};
		(strict ? errors : warnings).push(issue);
	}

	return {
		pass: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Format a {@link LearningValidationIssue} as a multi-line string suitable
 * for stderr / log output. Includes the offending text snippet and SKILL ref.
 *
 * @param issue - The issue to format.
 * @param rawText - The full learning text (for snippet context).
 * @returns A multi-line formatted string.
 */
export function formatValidationMessage(
	issue: LearningValidationIssue,
	rawText: string
): string {
	const snippet = (rawText ?? '').trim().slice(0, 80);
	const lines: string[] = [
		`✗ record-learning rule ${issue.rule} (${issue.ruleName}): ${issue.message}`,
		`  Got:    "${snippet}${(rawText ?? '').length > 80 ? '…' : ''}"`,
	];
	if (issue.suggestion) {
		lines.push(`  Fix:    ${issue.suggestion}`);
	}
	lines.push(`  See:    ${issue.skillRef}`);
	return lines.join('\n');
}

// ----- internal helpers -----

/**
 * Count rough sentences in text by splitting on `[.!?]+\s+`.
 * Trailing punctuation does not require a following whitespace, so we add
 * a sentinel split for terminal `[.!?]` to cover single-sentence inputs.
 */
function countSentences(text: string): number {
	if (!text) return 0;
	// Replace terminal `[.!?]` (with no trailing whitespace) with a marker so
	// `single-sentence.` counts as 1, not 0.
	const normalized = text.replace(/([.!?]+)\s*$/, '$1 ');
	const parts = normalized.split(SENTENCE_SPLIT_RE).filter((s) => s.trim().length > 0);
	return parts.length;
}

/**
 * Check rule 3: text must contain either
 *   (a) a second `[[Entity]]` link beyond the leading one, OR
 *   (b) an explicit source citation (PR/Task/Issue/Log/Ref/See/#NNN).
 */
function hasLinkOrSource(text: string, leadingEntity: string | undefined): boolean {
	// Strip the leading entity token before scanning so it isn't double-counted
	// as a "link".
	const stripped = leadingEntity ? text.slice(leadingEntity.length) : text;

	// (a) Second [[...]] link present?
	if (/\[\[[^\]]+\]\]/.test(stripped)) {
		return true;
	}

	// (b) Source citation patterns.
	const sourceRe =
		/(\bPR\s*#\d+|\bTask\s*#?[\w-]+|\bIssue\s*#?\d+|\bRef:\s*\S|\bSee:\s*\S|\bLog:\s*\S|#\d+)/i;
	return sourceRe.test(stripped);
}

/** Check rule 4 — leading first-person pronoun. */
function looksLogStyle(text: string): boolean {
	const head = text.replace(/^\[\[[^\]]+\]\]\s*/, '').trim();
	return LOG_STYLE_OPENERS.some((re) => re.test(head));
}

/**
 * Build a `[[Entity]] <text>` suggestion for an offending learning.
 * Picks a coarse entity name from the first capitalized token, falling
 * back to `[[Entity]]` when no obvious anchor is detectable.
 */
function buildEntityOpenerSuggestion(text: string): string {
	if (!text) return '[[Entity]] <state the insight>';
	// First capitalized token of length >=3, allowing CamelCase / dotted names.
	const tokenMatch = text.match(/\b[A-Z][A-Za-z0-9_.-]{2,}\b/);
	const anchor = tokenMatch ? tokenMatch[0] : 'Entity';
	return `[[${anchor}]] ${text}`;
}
