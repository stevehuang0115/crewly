/**
 * Ticket holds (crewly#1369 gap 1) — pure rules.
 *
 * A ticket is on hold when the owner said to stop: "do not merge PR #1138, do
 * not ask Steve". Before this module the hold lived only as a Log line, and
 * nothing read it: days later a janitor notice about the same worktree became
 * a new ticket ("Decide the fate of OPEN PR #1138") and a "merge?" card to the
 * owner, who tapped Yes without recognising it.
 *
 * A hold is read from (first match wins):
 * - the `hold` frontmatter field (set through the ticket update path);
 * - a hold label ({@link TICKET_HOLD_CONSTANTS.LABELS});
 * - legacy Log lines: "HOLD: …", "on hold", "do not merge", "不要合并", "owner
 *   said no" — unless a later Log line lifts it ("hold lifted").
 *
 * Held work is matched by what it names: PR numbers, branches and worktrees
 * (a worktree named `wt-crew257` also names ticket CREW-257). On held work the
 * only allowed action is {@link TICKET_HOLD_CONSTANTS.ALLOWED_ACTIONS}.
 *
 * @module services/project-tickets/ticket-hold
 */

import { TICKET_HOLD_CONSTANTS } from '../../constants.js';
import type { ProjectTicket } from '../../types/project-ticket.types.js';

/** Where a hold was read from. */
export type TicketHoldSource = 'field' | 'label' | 'log';

/** A ticket's hold. */
export interface TicketHold {
  /** The reason, in the words that set it */
  reason: string;
  source: TicketHoldSource;
  /** The ticket this one is held through ("held by CREW-257: …"), when linked */
  heldBy?: string;
}

/** PR numbers, branches, worktrees and ticket ids a text names. */
export interface WorkRefs {
  prs: number[];
  /** Branch names, lower-cased */
  branches: string[];
  /** Worktree folder names, lower-cased */
  worktrees: string[];
  /** Ticket ids, upper-cased */
  tickets: string[];
}

/** The fields of a ticket the hold rules read. */
export type HoldTicketView = Pick<ProjectTicket, 'id' | 'title' | 'labels' | 'log' | 'description'> &
  Partial<Pick<ProjectTicket, 'hold' | 'extra' | 'projectPath' | 'status'>>;

/** A held ticket that the work in question references. */
export interface HeldTicketMatch {
  ticketId: string;
  title: string;
  projectPath?: string;
  hold: TicketHold;
  /** What matched ("PR #1138", "branch feat/x", "worktree wt-crew257", "ticket CREW-257") */
  matchedOn: string[];
}

/** Uppercase HOLD as a word (not "holder", not "household"), and not "HOLD lifted". */
const HOLD_WORD = /(?:^|[\s:([\-—·*_"'`])HOLD\b(?![\s:]*(?:lifted|released|cleared|removed|off)\b)/;
/** Other ways to say it in a Log line. */
const HOLD_PHRASES =
  /\bon[\s-]hold\b|\b(?:do not|don't|dont|must not|mustn't|never|not to) (?:merge|ship|land)\b|\bowner (?:said|says|answered) (?:no|"no"|'no')\b|(?:不要|别|不准|先不|暂不|暂时不)(?:要)?(?:合并|合入|合进|merge)|暂停|搁置/iu;
/** A Log line that lifts a hold. */
const LIFT_PHRASES = /\bhold (?:lifted|released|cleared|removed)\b|\bunhold\b|\boff hold\b|\blift(?:ed)? the hold\b|解除(?:暂停|搁置|hold)|取消暂停/iu;

/**
 * The message part of a Log line (`<iso> · <actor> · <message>`).
 *
 * @param line - Log line (without `- `)
 * @returns The message
 */
function logMessage(line: string): string {
  const parts = line.split(' · ');
  return parts.length >= 3 ? parts.slice(2).join(' · ') : line;
}

/**
 * Clip a reason for quoting.
 *
 * @param s - Text
 * @returns One line of at most {@link TICKET_HOLD_CONSTANTS.REASON_MAX_CHARS}
 */
export function clipHoldReason(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const max = TICKET_HOLD_CONSTANTS.REASON_MAX_CHARS;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Whether a Log message puts the ticket on hold.
 *
 * @param message - Log message
 * @returns True for "HOLD: …", "on hold", "do not merge", "不要合并", …
 */
export function isHoldLogMessage(message: string): boolean {
  if (LIFT_PHRASES.test(message)) return false;
  return HOLD_WORD.test(message) || HOLD_PHRASES.test(message);
}

/**
 * Whether a Log message lifts a hold.
 *
 * @param message - Log message
 * @returns True for "hold lifted", "unhold", …
 */
export function isLiftLogMessage(message: string): boolean {
  return LIFT_PHRASES.test(message);
}

/**
 * The ticket id in a linked hold reason ("held by CREW-257: …").
 *
 * @param reason - Hold reason
 * @returns The id, or undefined
 */
function heldByOf(reason: string): string | undefined {
  const m = new RegExp(`^${TICKET_HOLD_CONSTANTS.LINKED_PREFIX}\\s+([A-Za-z0-9]+-\\d+)\\b`, 'i').exec(reason.trim());
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * A ticket's hold, or null when it is not held.
 *
 * @param t - Ticket
 * @returns The hold
 *
 * @example
 * readTicketHold({ ...t, log: ['2026-10-06T10:00:00Z · crewly-orc · HOLD: PR #1138: do not merge'] })
 * // → { reason: 'HOLD: PR #1138: do not merge', source: 'log' }
 */
export function readTicketHold(t: HoldTicketView): TicketHold | null {
  const field = typeof t.hold === 'string' ? t.hold.trim() : '';
  if (field) {
    const heldBy = heldByOf(field);
    return { reason: clipHoldReason(field), source: 'field', ...(heldBy ? { heldBy } : {}) };
  }
  // The latest hold / lift line in the Log decides.
  let fromLog: string | null = null;
  for (const line of t.log ?? []) {
    const message = logMessage(line);
    if (isLiftLogMessage(message)) fromLog = null;
    else if (isHoldLogMessage(message)) fromLog = message;
  }
  const labels = (t.labels ?? []).map((l) => l.toLowerCase());
  if (labels.some((l) => TICKET_HOLD_CONSTANTS.LABELS.includes(l))) {
    return { reason: clipHoldReason(fromLog ?? `labelled ${labels.find((l) => TICKET_HOLD_CONSTANTS.LABELS.includes(l))}`), source: 'label' };
  }
  return fromLog ? { reason: clipHoldReason(fromLog), source: 'log' } : null;
}

/**
 * Ticket id a worktree folder names: `wt-crew257` / `wt-crew-257` → `CREW-257`.
 *
 * @param name - Worktree folder name
 * @returns The id, or null
 */
export function ticketIdOfWorktree(name: string): string | null {
  const m = /^wt-([a-z][a-z0-9]{0,9}?)-?(\d{1,6})$/i.exec(name.trim());
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : null;
}

/** Branch prefixes that make a `<prefix>/<name>` word a branch. */
const BRANCH_PREFIX = '(?:feat|feature|fix|bugfix|hotfix|chore|docs|refactor|perf|test|tests|release|ci|build|style|crew|agent|wip)';

/**
 * PR numbers, branches, worktrees and ticket ids named in a text.
 *
 * Conservative: a bare `#123` is not a PR (issues use it too); a PR is
 * "PR #123", "PR 123", "pull request #123" or a `/pull/123` link. Ticket ids
 * come only from worktree names (`wt-crew257`), not from free text — a ticket
 * that merely mentions another one is not the same work.
 *
 * @param text - Any text
 * @returns The refs (deduplicated)
 */
export function extractWorkRefs(text: string): WorkRefs {
  const prs = new Set<number>();
  const branches = new Set<string>();
  const worktrees = new Set<string>();
  const tickets = new Set<string>();
  const src = String(text ?? '');
  for (const m of src.matchAll(/\b(?:PR|pull request|pull)\s*#?\s*(\d{1,7})\b/gi)) prs.add(Number(m[1]));
  for (const m of src.matchAll(/\/pull\/(\d{1,7})\b/g)) prs.add(Number(m[1]));
  const clean = (b: string): string => b.replace(/[.,;:)\]}'"`>]+$/, '').toLowerCase();
  for (const m of src.matchAll(/\b(?:branch|分支)\s*[`'"]?([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)/giu)) branches.add(clean(m[1]));
  for (const m of src.matchAll(new RegExp(`(?:^|[\\s\`'"(\\[])(${BRANCH_PREFIX}\\/[A-Za-z0-9._/-]+)`, 'gi'))) branches.add(clean(m[1]));
  for (const m of src.matchAll(/(?:^|[\s/`'"(\[])(wt-[A-Za-z0-9._-]+)/g)) {
    const name = clean(m[1]);
    worktrees.add(name);
    const id = ticketIdOfWorktree(name);
    if (id) tickets.add(id);
  }
  return { prs: [...prs], branches: [...branches].filter((b) => b.length > 0), worktrees: [...worktrees], tickets: [...tickets] };
}

/**
 * Merge several refs.
 *
 * @param all - Refs
 * @returns Union
 */
export function mergeWorkRefs(...all: WorkRefs[]): WorkRefs {
  const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
  return {
    prs: uniq(all.flatMap((r) => r.prs)),
    branches: uniq(all.flatMap((r) => r.branches)),
    worktrees: uniq(all.flatMap((r) => r.worktrees)),
    tickets: uniq(all.flatMap((r) => r.tickets)),
  };
}

/**
 * Refs of a branch and worktree path (the janitor's view of a worktree).
 *
 * @param branch - Branch, or null
 * @param worktreePath - Worktree path
 * @returns Refs
 */
export function worktreeRefs(branch: string | null, worktreePath: string): WorkRefs {
  const name = (worktreePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').toLowerCase();
  const id = ticketIdOfWorktree(name);
  return { prs: [], branches: branch ? [branch.toLowerCase()] : [], worktrees: name ? [name] : [], tickets: id ? [id] : [] };
}

/**
 * Everything a ticket names: title, description, Log and the frontmatter keys
 * a human may add (`pr`, `branch`, `worktree`).
 *
 * @param t - Ticket
 * @returns Refs
 */
export function ticketWorkRefs(t: HoldTicketView): WorkRefs {
  const extra = t.extra ?? {};
  const prField = extra.pr !== undefined && extra.pr !== null && /^\d+$/.test(String(extra.pr)) ? `PR #${extra.pr}` : '';
  const branch = typeof extra.branch === 'string' ? extra.branch.trim().toLowerCase() : '';
  const worktreeField = typeof extra.worktree === 'string' && extra.worktree.trim() ? ` ${extra.worktree.trim()}` : '';
  const fromText = extractWorkRefs([t.title, t.description, ...(t.log ?? []), prField, worktreeField].join('\n'));
  return branch ? mergeWorkRefs(fromText, { prs: [], branches: [branch], worktrees: [], tickets: [] }) : fromText;
}

/**
 * Which held tickets the given refs point at.
 *
 * @param refs - What the new work names
 * @param tickets - Candidate tickets (any status)
 * @param opts - `excludeId`: the ticket being checked itself
 * @returns Matches, tickets held in their own right first
 */
export function findHeldMatches(refs: WorkRefs, tickets: readonly HoldTicketView[], opts: { excludeId?: string } = {}): HeldTicketMatch[] {
  const out: HeldTicketMatch[] = [];
  for (const t of tickets) {
    if (opts.excludeId && t.id.toLowerCase() === opts.excludeId.toLowerCase()) continue;
    const hold = readTicketHold(t);
    if (!hold) continue;
    const own = ticketWorkRefs(t);
    const matchedOn: string[] = [];
    for (const n of refs.prs) if (own.prs.includes(n)) matchedOn.push(`PR #${n}`);
    for (const b of refs.branches) if (own.branches.includes(b)) matchedOn.push(`branch ${b}`);
    for (const w of refs.worktrees) if (own.worktrees.includes(w)) matchedOn.push(`worktree ${w}`);
    if (refs.tickets.includes(t.id.toUpperCase())) matchedOn.push(`ticket ${t.id}`);
    if (matchedOn.length === 0) continue;
    out.push({ ticketId: t.id, title: t.title, ...(t.projectPath ? { projectPath: t.projectPath } : {}), hold, matchedOn });
  }
  return out.sort((a, b) => Number(!!a.hold.heldBy) - Number(!!b.hold.heldBy));
}

/**
 * The hold reason written on a ticket held through another one.
 *
 * @param match - The held ticket it references
 * @returns `held by CREW-257: <reason>`
 */
export function linkedHoldReason(match: HeldTicketMatch): string {
  const root = match.hold.heldBy ?? match.ticketId;
  const reason = match.hold.reason.replace(new RegExp(`^${TICKET_HOLD_CONSTANTS.LINKED_PREFIX}\\s+[A-Za-z0-9]+-\\d+:\\s*`, 'i'), '');
  return clipHoldReason(`${TICKET_HOLD_CONSTANTS.LINKED_PREFIX} ${root}: ${reason}`);
}

/**
 * The note put at the top of a held follow-up ticket's description, so the
 * agent who picks it up reads the hold before anything else.
 *
 * @param match - The held ticket
 * @returns One paragraph
 */
export function heldDescriptionNote(match: HeldTicketMatch): string {
  const root = match.hold.heldBy ?? match.ticketId;
  return (
    `ON HOLD (${root}, matched on ${match.matchedOn.join(', ')}): "${match.hold.reason}". ` +
    `Allowed actions: ${TICKET_HOLD_CONSTANTS.ALLOWED_ACTIONS} only. Do not merge it, and do not ask the owner to merge it.`
  );
}

/** Merge-style words: the card would move held work forward. */
const MERGE_WORDS = /\bmerg(?:e|es|ed|ing)\b|\bship(?:ping)? it\b|\bland(?:ing)? it\b|\bgo ahead\b|\bproceed\b|\bcontinue\b|\bresume\b|\bdeploy\b|合并|合入|合进|上线|继续|部署/iu;
/** Close-style words. */
const CLOSE_WORDS = /\bclos(?:e|es|ed|ing)\b|\bdrop\b|\babandon\b|\bdiscard\b|\bremove\b|\bdelete\b|关闭|关掉|关了|删掉|删除|放弃|丢掉/iu;
/** Negated merge phrases that a close question may quote ("you said do not merge"). */
const NEGATED_MERGE = /\b(?:do not|don't|dont|not|never|no|without)\s+(?:merg(?:e|ing)|ship(?:ping)?|land(?:ing)?)\b|(?:不要|别|不|没|先不|暂不)(?:要)?(?:合并|合入|合进)/giu;

/**
 * Whether a card only asks to close / drop held work.
 *
 * @param text - Question plus option labels
 * @returns True for "Close PR #1138?" with no merge option
 */
export function isCloseOnlyAsk(text: string): boolean {
  const stripped = text.replace(NEGATED_MERGE, ' ');
  return CLOSE_WORDS.test(stripped) && !MERGE_WORDS.test(stripped);
}

/**
 * Why a decision card about held work is refused, or null when it may go up.
 *
 * @param text - Question, option labels and details
 * @param matches - Held tickets it references
 * @returns The refusal (quotes the hold), or null
 */
export function decisionHoldRefusal(text: string, matches: readonly HeldTicketMatch[]): string | null {
  if (matches.length === 0 || isCloseOnlyAsk(text)) return null;
  const m = matches[0];
  const root = m.hold.heldBy ?? m.ticketId;
  return (
    `${root} is on hold (${m.matchedOn.join(', ')}): "${m.hold.reason}". ` +
    `The only allowed action is to ${TICKET_HOLD_CONSTANTS.ALLOWED_ACTIONS}. Do not ask the owner to merge or continue it. ` +
    `If you need the owner, ask whether to close it (e.g. "Close PR …? You put it on hold on ${root}."), or lift the hold on ${root} first if the owner said so.`
  );
}

/**
 * The line the janitor's unmerged-worktree notice carries for held work.
 *
 * @param match - The held ticket
 * @returns One sentence
 */
export function heldWorktreeNoticeLine(match: HeldTicketMatch): string {
  const root = match.hold.heldBy ?? match.ticketId;
  return (
    `This work is ON HOLD on ticket ${root}: "${match.hold.reason}". Do not merge it, do not open a new ticket about it ` +
    `and do not ask the owner about merging: ${TICKET_HOLD_CONSTANTS.ALLOWED_ACTIONS} (log it on ${root}).`
  );
}
