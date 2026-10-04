/**
 * The ask-owner contract (specs/2026-10-01-decision-cards.md §1): validate a
 * structured owner question and turn it into a {@link ValidatedAsk}. Pure.
 *
 * Every rejection says what to fix and shows a correct ask, because the
 * reader is an agent that will retry with whatever the error tells it.
 *
 * @module services/decisions/decision-contract
 */

import { DECISION_CONSTANTS } from '../../constants.js';
import type { AskOwnerInput, DecisionOption, DecisionSensitiveKind, ValidatedAsk } from '../../types/decision.types.js';

/** A rejected ask. */
export class DecisionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionContractError';
  }
}

/** The example appended to every contract error. */
export const ASK_OWNER_EXAMPLE =
  'Example: ask-owner --question "Send the partner email on Monday?" --option "Send Monday — after the review call" --option "Hold — wait for legal" [--option "Third choice"] --default "Hold" [--deadline 2026-10-02T12:00] [--ticket APP-12 --project P] [--sensitive email]';

const OPTION_KEYS = ['a', 'b', 'c', 'd', 'e'];

/** Separators accepted between an option's label and its detail in a string form. */
const DETAIL_SEPARATOR = /\s+(?:—|–|--|-|:)\s+/;

/**
 * Collapse whitespace.
 *
 * @param s - Text
 * @returns One trimmed line
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The next day at {@link DECISION_CONSTANTS.DEFAULT_DEADLINE_HOUR_LOCAL}:00 local.
 *
 * @param now - Clock
 * @returns Default deadline
 */
export function defaultDeadline(now: Date): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + 1);
  d.setHours(DECISION_CONSTANTS.DEFAULT_DEADLINE_HOUR_LOCAL, 0, 0, 0);
  return d;
}

/**
 * Whether a question is too vague to put in front of the owner.
 *
 * @param question - One-line question
 * @returns True for "thoughts?", "OK?", "可以吗" and the like
 */
export function isVagueQuestion(question: string): boolean {
  const core = question.toLowerCase().replace(/[\s?？!！.。…]+$/u, '').trim();
  return (DECISION_CONSTANTS.VAGUE_QUESTIONS as readonly string[]).includes(core);
}

/**
 * Parse the options: an array of `{label, detail?}` objects or of strings
 * (`"Label"` / `"Label — detail"`).
 *
 * @param raw - Input
 * @returns Options with keys a/b/c
 * @throws DecisionContractError
 */
export function parseOptions(raw: unknown): DecisionOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new DecisionContractError(
      `options are required: give the owner ${DECISION_CONSTANTS.MIN_OPTIONS}–${DECISION_CONSTANTS.MAX_OPTIONS} concrete choices they can tap. ${ASK_OWNER_EXAMPLE}`,
    );
  }
  if (raw.length < DECISION_CONSTANTS.MIN_OPTIONS || raw.length > DECISION_CONSTANTS.MAX_OPTIONS) {
    throw new DecisionContractError(
      `give ${DECISION_CONSTANTS.MIN_OPTIONS}–${DECISION_CONSTANTS.MAX_OPTIONS} options (got ${raw.length}). Pick the real alternatives; leave out "other". ${ASK_OWNER_EXAMPLE}`,
    );
  }
  const options: DecisionOption[] = raw.map((item, i) => {
    let label = '';
    let detail: string | undefined;
    if (typeof item === 'string') {
      const text = oneLine(item);
      const m = DETAIL_SEPARATOR.exec(text);
      if (m && m.index > 0) {
        label = text.slice(0, m.index).trim();
        detail = text.slice(m.index + m[0].length).trim() || undefined;
      } else {
        label = text;
      }
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      label = typeof o.label === 'string' ? oneLine(o.label) : '';
      detail = typeof o.detail === 'string' && oneLine(o.detail) ? oneLine(o.detail) : undefined;
    }
    if (!label) throw new DecisionContractError(`option ${i + 1} has no label. ${ASK_OWNER_EXAMPLE}`);
    if (label.length > DECISION_CONSTANTS.OPTION_LABEL_MAX_CHARS) {
      throw new DecisionContractError(
        `option "${label.slice(0, 30)}…" is too long for a button (max ${DECISION_CONSTANTS.OPTION_LABEL_MAX_CHARS} characters): put the short choice first and the explanation after " — ".`,
      );
    }
    if (detail && detail.length > DECISION_CONSTANTS.OPTION_DETAIL_MAX_CHARS) {
      throw new DecisionContractError(`the detail of option "${label}" is too long (max ${DECISION_CONSTANTS.OPTION_DETAIL_MAX_CHARS} characters).`);
    }
    return { key: OPTION_KEYS[i], label, ...(detail ? { detail } : {}) };
  });
  const seen = new Set<string>();
  for (const o of options) {
    const k = o.label.toLowerCase();
    if (seen.has(k)) throw new DecisionContractError(`two options are both "${o.label}": each option must be a different choice.`);
    seen.add(k);
  }
  return options;
}

/**
 * Resolve the default to an option key or `wait`.
 *
 * @param raw - Label, key (a/b/c), number (1–3) or `wait`
 * @param options - Parsed options
 * @returns Option key or `wait`
 * @throws DecisionContractError
 */
export function resolveDefault(raw: unknown, options: DecisionOption[]): string {
  const text = typeof raw === 'string' ? oneLine(raw) : typeof raw === 'number' ? String(raw) : '';
  if (!text) {
    throw new DecisionContractError(
      `default is required: the option you will take if the owner does not answer by the deadline, or "wait" to do nothing until they answer. ${ASK_OWNER_EXAMPLE}`,
    );
  }
  const found = matchOption(text, options);
  if (found) return found.key;
  if (text.toLowerCase() === DECISION_CONSTANTS.WAIT_DEFAULT) return DECISION_CONSTANTS.WAIT_DEFAULT;
  throw new DecisionContractError(
    `default "${text}" is not one of the options (${options.map((o) => `"${o.label}"`).join(', ')}) and not "wait".`,
  );
}

/**
 * Find the option a label, key (a/b/c) or number (1–3) names.
 *
 * @param text - What was given
 * @param options - Options
 * @returns The option, or null
 */
export function matchOption(text: string, options: DecisionOption[]): DecisionOption | null {
  const t = oneLine(text).toLowerCase().replace(/[.。!！]+$/u, '');
  if (!t) return null;
  const byLabel = options.find((o) => o.label.toLowerCase() === t);
  if (byLabel) return byLabel;
  const byKey = options.find((o) => o.key === t);
  if (byKey) return byKey;
  const n = /^#?(\d)$/.exec(t);
  if (n) {
    const idx = Number(n[1]) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  return null;
}

/**
 * Parse the deadline.
 *
 * @param raw - ISO / date-time string, or empty for the default
 * @param now - Clock
 * @returns The deadline
 * @throws DecisionContractError when unreadable or not in the future
 */
export function parseDeadline(raw: unknown, now: Date): Date {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return defaultDeadline(now);
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw).trim());
  if (!Number.isFinite(ms)) {
    throw new DecisionContractError(`deadline "${String(raw)}" is not a date-time. Use ISO, e.g. 2026-10-02T12:00, or leave it out (default: tomorrow 12:00).`);
  }
  if (ms <= now.getTime()) throw new DecisionContractError(`deadline ${new Date(ms).toISOString()} is in the past.`);
  return new Date(ms);
}

/**
 * Parse the sensitive kind.
 *
 * @param raw - `email` | `publish` | `deploy` | `spend`, or empty
 * @returns The kind, or undefined
 * @throws DecisionContractError on anything else
 */
export function parseSensitive(raw: unknown): DecisionSensitiveKind | undefined {
  if (raw === undefined || raw === null || raw === '' || raw === false) return undefined;
  const v = String(raw).trim().toLowerCase();
  if ((DECISION_CONSTANTS.SENSITIVE_KINDS as readonly string[]).includes(v)) return v as DecisionSensitiveKind;
  throw new DecisionContractError(
    `sensitive must be one of ${DECISION_CONSTANTS.SENSITIVE_KINDS.join(' | ')} (outside email/messages, public publishing, prod deploys, spending money).`,
  );
}

/**
 * Validate a whole ask.
 *
 * @param input - Raw input (skill / API body)
 * @param now - Clock
 * @returns The validated ask
 * @throws DecisionContractError with a fix-it message
 */
export function validateAskOwner(input: AskOwnerInput, now: Date = new Date()): ValidatedAsk {
  const rawQ = typeof input.question === 'string' ? input.question : '';
  if (/\n\s*\S/.test(rawQ.trim())) {
    throw new DecisionContractError('question must be ONE line. Put the context in the ticket, the choices in --option. ' + ASK_OWNER_EXAMPLE);
  }
  const question = oneLine(rawQ);
  if (!question) throw new DecisionContractError(`question is required. ${ASK_OWNER_EXAMPLE}`);
  if (question.length > DECISION_CONSTANTS.QUESTION_MAX_CHARS) {
    throw new DecisionContractError(`question is too long (max ${DECISION_CONSTANTS.QUESTION_MAX_CHARS} characters) — one line the owner can answer with a tap.`);
  }
  if (question.length < DECISION_CONSTANTS.QUESTION_MIN_CHARS || isVagueQuestion(question)) {
    throw new DecisionContractError(
      `"${question}" is too vague to answer from a phone. Name the concrete decision (what, and when), e.g. "Send the partner email on Monday?". ${ASK_OWNER_EXAMPLE}`,
    );
  }
  const options = parseOptions(input.options);
  const defaultKey = resolveDefault(input.default, options);
  const deadline = parseDeadline(input.deadline, now);
  const sensitive = parseSensitive(input.sensitive);
  const ticketId = typeof input.ticket === 'string' && input.ticket.trim() ? input.ticket.trim() : undefined;
  const project = typeof input.project === 'string' && input.project.trim() ? input.project.trim() : undefined;
  if (ticketId && !project) throw new DecisionContractError('ticket needs --project too (the project the ticket belongs to).');
  return {
    question,
    options,
    defaultKey,
    deadline,
    ...(sensitive ? { sensitive } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(project ? { project } : {}),
  };
}

/** Option labels that make a card a plain yes/no. */
const YES_NO_LABELS = new Set(['yes', 'no', 'y', 'n', '是', '否', '好', '不', '要', '不要', '同意', '不同意']);

/**
 * Whether a card's options are a plain yes/no pair.
 *
 * @param options - Parsed options
 * @returns True for exactly two options that are both yes/no words
 */
export function isYesNoOptions(options: Array<Pick<DecisionOption, 'label'>>): boolean {
  return options.length === 2 && options.every((o) => YES_NO_LABELS.has(o.label.toLowerCase().replace(/[.。!！]+$/u, '')));
}

/**
 * Whether two questions asked back to back are really one either/or:
 * the second starts with 还是 / 或者 / "or ", or the first ends in an
 * either/or clause ("A, or B?").
 *
 * @param first - The earlier question
 * @param second - The later question
 * @returns True when the pair reads as alternatives
 */
export function readsAsEitherOr(first: string, second: string): boolean {
  if (/^\s*(?:还是|或者|或是)|^\s*or\s/i.test(second)) return true;
  const lastClause = first.replace(/[？?]\s*$/u, '').split(/[，,：:；;]/).pop() ?? '';
  return /还是|或者|\bor\b/i.test(lastClause);
}

/**
 * The fix-it message for a second yes/no ask that is the other half of an either/or.
 *
 * @param earlierId - Id of the earlier decision
 * @returns Error text
 */
export function eitherOrMessage(earlierId: string): string {
  return (
    `this looks like the other half of an either/or you just asked as ${earlierId}: two Yes/No cards for alternatives leave the owner tapping Yes twice. ` +
    `Withdraw ${earlierId} (ask-owner --cancel ${earlierId}) and post ONE card with one option per alternative, e.g. ` +
    `ask-owner --question "Change the dinner card now, or try the current version for a week first?" --option "Change it now" --option "Try a week first" --default wait. ${ASK_OWNER_EXAMPLE}`
  );
}
