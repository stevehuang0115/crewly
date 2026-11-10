/**
 * Per-link norms of shared channels (crewly#1543 slice 6).
 *
 * The owner's model: with another company's Crewly account, simple
 * information goes freely; internal information needs his approval unless a
 * norm he set up in advance for that link allows it. A norm has two parts:
 *
 * - **free text** ("what this partner may be told"), shown to the
 *   orchestrator with every message from that company and in
 *   `post-shared-channel --list`;
 * - **allowances**: kinds of content the classifier would hold that may go to
 *   this partner without a card once the link's trial is over.
 *
 * Only some hold reasons can be allowed ({@link SHARED_NORM_ALLOWANCES}).
 * Refusals (secrets, children's data, another person's private data) and the
 * holds that guard people's or the owner's private data (children mentioned,
 * ID numbers, the owner's connector content, text marked confidential) can
 * never be allowed by a norm.
 *
 * @module services/shared-channel/shared-channel-norms
 */

import { SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import type { SharedSendFinding, SharedSendFindingCode } from './shared-channel-classifier.js';

/** Activity-log actions of norm changes (target `shared_channel:<linkId>`). */
export const SHARED_NORM_ACTIONS = {
  UPDATED: 'shared_channel.norm.updated',
} as const;

/** A kind of content a norm can let through. */
export type SharedNormAllowance =
  | 'money'
  | 'file_names'
  | 'contact_details'
  | 'internal_links'
  | 'internal_refs'
  | 'wiki_notes'
  | 'code_blocks'
  | 'long_messages';

/** One allowance as the owner sees it. */
export interface SharedNormAllowanceInfo {
  key: SharedNormAllowance;
  /** Short label for a checkbox */
  label: string;
  /** One line on what it lets through */
  detail: string;
  /** Classifier hold codes it covers */
  codes: readonly SharedSendFindingCode[];
}

/** Every allowance, in the order the owner sees them. */
export const SHARED_NORM_ALLOWANCES: readonly SharedNormAllowanceInfo[] = [
  { key: 'money', label: 'Money', detail: 'amounts, prices, budgets, invoices', codes: ['money'] },
  { key: 'file_names', label: 'File names and paths', detail: 'names of files and folders, file paths', codes: ['file_path'] },
  { key: 'contact_details', label: "Our staff's email addresses and phone numbers", detail: 'contact details of your own people (say whose in the norm text)', codes: ['email', 'phone'] },
  { key: 'internal_links', label: 'Internal links', detail: 'links to this machine, the private network or Crewly app pages', codes: ['internal_url'] },
  { key: 'internal_refs', label: 'Ticket ids and internal references', detail: 'ticket and decision ids, session names, object ids', codes: ['internal_ref'] },
  { key: 'wiki_notes', label: 'Wiki and notes', detail: 'excerpts from the wiki, memory or meeting notes', codes: ['wiki_memory'] },
  { key: 'code_blocks', label: 'Code blocks', detail: 'code or command output in ``` blocks', codes: ['code_block'] },
  { key: 'long_messages', label: 'Long messages', detail: `messages over ${SHARED_CHANNEL_CONSTANTS.CLASSIFIER_LONG_TEXT_CHARS} characters`, codes: ['long_text'] },
];

/** Classifier codes no norm can ever allow (refusals, and holds that guard private data). */
export const NEVER_ALLOWED_CODES: ReadonlySet<SharedSendFindingCode> = new Set<SharedSendFindingCode>([
  'secret',
  'children_data',
  'private_person_data',
  'children_mention',
  'id_number',
  'owner_connector',
  'confidential',
]);

const ALLOWANCE_KEYS: ReadonlySet<string> = new Set(SHARED_NORM_ALLOWANCES.map((a) => a.key));

/** The norm of one link. */
export interface SharedChannelNorm {
  /** The owner's own words: what this partner may be told ('' when unset) */
  norm: string;
  /** Kinds of content that go without a card after the trial */
  allow: SharedNormAllowance[];
  /** ISO time of the last change ('' when never set) */
  updatedAt: string;
}

/** A norm nobody has set yet. */
export const EMPTY_NORM: Readonly<SharedChannelNorm> = Object.freeze({ norm: '', allow: [], updatedAt: '' });

/**
 * Whether a value is a known allowance key.
 *
 * @param value - Anything
 * @returns True for a {@link SharedNormAllowance}
 */
export function isSharedNormAllowance(value: unknown): value is SharedNormAllowance {
  return typeof value === 'string' && ALLOWANCE_KEYS.has(value);
}

/**
 * The allowance that covers a classifier code, if any.
 *
 * @param code - Classifier finding code
 * @returns The allowance, or undefined when no norm can allow it
 */
export function allowanceForCode(code: SharedSendFindingCode): SharedNormAllowance | undefined {
  if (NEVER_ALLOWED_CODES.has(code)) return undefined;
  return SHARED_NORM_ALLOWANCES.find((a) => a.codes.includes(code))?.key;
}

/**
 * Allowances in catalogue order, without duplicates or unknown keys.
 *
 * @param keys - Allowance keys
 * @returns Normalised list
 */
export function normalizeAllowances(keys: readonly unknown[]): SharedNormAllowance[] {
  const wanted = new Set(keys.filter(isSharedNormAllowance));
  return SHARED_NORM_ALLOWANCES.map((a) => a.key).filter((k) => wanted.has(k));
}

/** {@link splitByNorm} result. */
export interface NormSplit {
  /** Findings the norm lets through */
  allowed: SharedSendFinding[];
  /** Findings that still hold (or refuse) the message */
  remaining: SharedSendFinding[];
}

/**
 * Split classifier findings into those the link's allowances cover and the rest.
 *
 * @param findings - Classifier findings
 * @param allow - The link's allowances
 * @returns Allowed and remaining findings
 *
 * @example
 * ```typescript
 * splitByNorm([{ code: 'money', reason: '…' }], ['money']).remaining; // []
 * splitByNorm([{ code: 'secret', reason: '…' }], ['money']).remaining.length; // 1 (never allowed)
 * ```
 */
export function splitByNorm(findings: readonly SharedSendFinding[], allow: readonly SharedNormAllowance[]): NormSplit {
  const allowed: SharedSendFinding[] = [];
  const remaining: SharedSendFinding[] = [];
  const set = new Set(allow);
  for (const f of findings) {
    const a = allowanceForCode(f.code);
    if (a && set.has(a)) allowed.push(f);
    else remaining.push(f);
  }
  return { allowed, remaining };
}

/**
 * The allowances that would cover every finding, or null when some finding
 * cannot be allowed (then no "always allow" is offered).
 *
 * @param findings - Findings that hold a message
 * @returns Allowances in catalogue order, or null
 */
export function allowancesCovering(findings: readonly SharedSendFinding[]): SharedNormAllowance[] | null {
  if (findings.length === 0) return null;
  const keys: SharedNormAllowance[] = [];
  for (const f of findings) {
    const a = allowanceForCode(f.code);
    if (!a) return null;
    keys.push(a);
  }
  return normalizeAllowances(keys);
}

/**
 * Lower-case labels of allowances, joined ("money, file names and paths").
 *
 * @param keys - Allowances
 * @returns Phrase ('' when none)
 */
export function describeAllowances(keys: readonly SharedNormAllowance[]): string {
  return SHARED_NORM_ALLOWANCES.filter((a) => keys.includes(a.key))
    .map((a) => a.label.toLowerCase())
    .join(', ');
}

/** A validated change to a norm ({@link parseNormUpdate}). */
export interface SharedNormUpdate {
  norm?: string;
  allow?: SharedNormAllowance[];
}

/**
 * Validate an owner's change: `{ norm?: string, allow?: string[] }`.
 * Codes that can never be allowed (e.g. `secret`) are named in the error.
 *
 * @param body - Request body
 * @returns The update, or an error message
 */
export function parseNormUpdate(body: unknown): { ok: true; update: SharedNormUpdate } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send { norm?: string, allow?: string[] }.' };
  const b = body as Record<string, unknown>;
  const update: SharedNormUpdate = {};
  if (b.norm !== undefined) {
    if (typeof b.norm !== 'string') return { ok: false, error: 'norm must be text.' };
    const norm = b.norm.replace(/\r\n/g, '\n').trim();
    if (norm.length > SHARED_CHANNEL_CONSTANTS.NORM_MAX_CHARS) return { ok: false, error: `A norm is at most ${SHARED_CHANNEL_CONSTANTS.NORM_MAX_CHARS} characters.` };
    update.norm = norm;
  }
  if (b.allow !== undefined) {
    if (!Array.isArray(b.allow)) return { ok: false, error: 'allow must be a list.' };
    const never = b.allow.filter((k) => typeof k === 'string' && NEVER_ALLOWED_CODES.has(k as SharedSendFindingCode));
    if (never.length > 0) {
      return { ok: false, error: `${never.join(', ')} can never be allowed by a norm: secrets, children's data and private data are never sent by an agent.` };
    }
    const unknown = b.allow.filter((k) => !isSharedNormAllowance(k));
    if (unknown.length > 0) return { ok: false, error: `Unknown allowance: ${unknown.map(String).join(', ')}. Known: ${[...ALLOWANCE_KEYS].join(', ')}.` };
    update.allow = normalizeAllowances(b.allow);
  }
  if (update.norm === undefined && update.allow === undefined) return { ok: false, error: 'Nothing to change: send norm and/or allow.' };
  return { ok: true, update };
}

/**
 * The norm as the orchestrator reads it in the `[EXTERNAL]` header.
 *
 * @param norm - The link's norm
 * @param counterpart - The other company
 * @returns One paragraph, or '' when nothing is set
 */
export function describeNormForAgent(norm: Pick<SharedChannelNorm, 'norm' | 'allow'> | undefined, counterpart: string): string {
  if (!norm || (!norm.norm && norm.allow.length === 0)) {
    return `The owner set no norm for ${counterpart}: share only simple information; anything internal waits for him.`;
  }
  const parts: string[] = [];
  if (norm.norm) parts.push(`The owner's norm for ${counterpart}: "${norm.norm}"`);
  if (norm.allow.length > 0) parts.push(`It may be sent without his approval: ${describeAllowances(norm.allow)}.`);
  parts.push('Everything else internal still waits for him; secrets and children\'s data never go.');
  return parts.join(' ');
}
