/**
 * Placeholders and answers of solution bundles.
 *
 * A bundle's prompts, norms, SOPs, schedules and tasks contain
 * `{{question_id}}` placeholders. The owner's answers to the bundle's
 * deploy-time questions fill them. Two built-ins (`team_name`,
 * `lead_name`) are filled by the engine per team.
 *
 * @module services/bundle/bundle-placeholders
 */

import { BUNDLE_CONSTANTS } from '../../constants.js';
import type { BundleQuestion } from '../../types/solution-bundle.types.js';

/** `{{ name }}`: lower snake case, optional spaces inside the braces. */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Answer values after defaults: a string, or a list for multiselect. */
export type BundleAnswerValue = string | string[];

/** Answers keyed by question id. */
export type BundleAnswers = Record<string, BundleAnswerValue>;

/** A question the owner has to (re)answer. */
export interface BundleAnswerProblem {
  id: string;
  label: string;
  /** Owner-facing reason */
  reason: string;
}

/**
 * The owner's answers are incomplete or invalid. `missing` lists required
 * questions without an answer; `invalid` lists answers that do not fit.
 */
export class BundleAnswersError extends Error {
  readonly code = 'invalid_answers';

  /**
   * @param missing - Required questions left empty
   * @param invalid - Answers that do not fit their question
   */
  constructor(
    readonly missing: BundleAnswerProblem[],
    readonly invalid: BundleAnswerProblem[],
  ) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`还没回答：${missing.map((m) => `${m.label}（${m.id}）`).join('、')}`);
    if (invalid.length > 0) parts.push(`回答不对：${invalid.map((m) => `${m.label}（${m.id}）：${m.reason}`).join('；')}`);
    super(parts.join('。'));
    this.name = 'BundleAnswersError';
  }
}

/**
 * A text still contains a placeholder nobody fills (a template bug, or a
 * built-in used outside a team).
 */
export class BundlePlaceholderError extends Error {
  readonly code = 'unfilled_placeholder';

  /**
   * @param names - Placeholder names without a value
   * @param where - Which text they are in (for the message)
   */
  constructor(
    readonly names: string[],
    readonly where: string,
  ) {
    super(`No value for {{${names.join('}}, {{')}}} in ${where}`);
    this.name = 'BundlePlaceholderError';
  }
}

/**
 * The placeholder names a text uses, each once, in order of appearance.
 *
 * @param text - Any text (undefined reads as empty)
 * @returns Placeholder names
 *
 * @example
 * listPlaceholders('给 {{business_name}} 写 {{ platform }}') // ['business_name', 'platform']
 */
export function listPlaceholders(text: string | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) seen.add(match[1]);
  return [...seen];
}

/**
 * Turn an answer value into the text that fills a placeholder.
 *
 * @param value - Answer
 * @returns Text (multiselect values joined with 、)
 */
export function answerText(value: BundleAnswerValue): string {
  return Array.isArray(value) ? value.join(BUNDLE_CONSTANTS.MULTISELECT_JOINER) : value;
}

/**
 * Replace every placeholder in a text.
 *
 * @param text - Text with `{{name}}` placeholders
 * @param values - Values by placeholder name
 * @param where - Label for the error message (e.g. `norm content-review`)
 * @returns The filled text
 * @throws BundlePlaceholderError when a placeholder has no value
 *
 * @example
 * fillPlaceholders('你好 {{business_name}}', { business_name: '小周咖啡' }, 'prompt') // '你好 小周咖啡'
 */
export function fillPlaceholders(text: string, values: Record<string, BundleAnswerValue>, where: string): string {
  const missing = listPlaceholders(text).filter((name) => values[name] === undefined);
  if (missing.length > 0) throw new BundlePlaceholderError(missing, where);
  return text.replace(PLACEHOLDER_PATTERN, (_m, name: string) => answerText(values[name]));
}

/**
 * Normalize one raw answer (trim, drop empties).
 *
 * @param raw - What the client sent
 * @returns A string, a list, or undefined for "no answer"
 */
function normalizeRaw(raw: unknown): BundleAnswerValue | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(raw)) {
    const list = raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0);
    return list.length > 0 ? list : undefined;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

/**
 * Check the owner's answers against the questions and apply defaults.
 *
 * - A required question without an answer is reported as missing.
 * - An optional question without an answer takes its `default`.
 * - Select answers must be one of the options; a multiselect accepts a list
 *   (or a single value); text answers are capped at MAX_ANSWER_LENGTH.
 * - Answers to unknown question ids are ignored.
 *
 * @param questions - The bundle's questions
 * @param raw - Answers from the client (any JSON)
 * @returns Answers for every question
 * @throws BundleAnswersError listing every missing or invalid answer at once
 *
 * @example
 * resolveAnswers([{ id: 'tone', label: '语气', type: 'text', required: false, default: '亲切' }], {})
 * // { tone: '亲切' }
 */
export function resolveAnswers(questions: BundleQuestion[], raw: unknown): BundleAnswers {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: BundleAnswers = {};
  const missing: BundleAnswerProblem[] = [];
  const invalid: BundleAnswerProblem[] = [];

  for (const q of questions) {
    let value = normalizeRaw(input[q.id]);
    if (value === undefined) {
      if (q.required) {
        missing.push({ id: q.id, label: q.label, reason: '必填' });
        continue;
      }
      value = q.default ?? '';
    }
    const allowed = new Set((q.options ?? []).map((o) => o.value));
    if (q.type === 'select') {
      const single = Array.isArray(value) ? value[0] ?? '' : value;
      if (single !== '' && !allowed.has(single)) {
        invalid.push({ id: q.id, label: q.label, reason: `只能选 ${[...allowed].join(' / ')}` });
        continue;
      }
      out[q.id] = single;
      continue;
    }
    if (q.type === 'multiselect') {
      const list = Array.isArray(value) ? value : value === '' ? [] : [value];
      const bad = list.filter((v) => !allowed.has(v));
      if (bad.length > 0) {
        invalid.push({ id: q.id, label: q.label, reason: `没有这些选项：${bad.join('、')}` });
        continue;
      }
      out[q.id] = list;
      continue;
    }
    const text = Array.isArray(value) ? value.join(BUNDLE_CONSTANTS.MULTISELECT_JOINER) : value;
    if (text.length > BUNDLE_CONSTANTS.MAX_ANSWER_LENGTH) {
      invalid.push({ id: q.id, label: q.label, reason: `太长了（最多 ${BUNDLE_CONSTANTS.MAX_ANSWER_LENGTH} 字）` });
      continue;
    }
    out[q.id] = text;
  }

  if (missing.length > 0 || invalid.length > 0) throw new BundleAnswersError(missing, invalid);
  return out;
}
