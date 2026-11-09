/**
 * Owner-facing wording of decision cards (crewly#1367, crewly#1369 §3). Pure.
 *
 * A card is read by the owner on a phone: it leads with the question in
 * plain words, in the owner's language. Ticket ids, PR numbers, branch and
 * worktree names and `GOAL:` prefixes are internal mechanics; they are
 * taken out of the question when the card is created (a PR link may stay in
 * a short details line). The harness's own text on the card — buttons, the
 * context line, reminders — follows the owner's language.
 *
 * Card D-822 (2026-10-16) is the incident: its title was
 * "CREW-646 · GOAL: Decide the fate of OPEN PR #1138 (…, CREW-257), worktree
 * crewly-projec…", in English, to an owner who writes Chinese; the question
 * really was "should agent-sent Gmail go out only after you approve a card?".
 *
 * The Chinese strings below are owner-facing text in the owner's language
 * (an allowed exception to the English-only rule).
 *
 * @module services/decisions/decision-wording
 */

import { DECISION_WORDING_CONSTANTS as W } from '../../constants.js';
import type { DecisionContext, DecisionLanguage, DecisionOption } from '../../types/decision.types.js';
import { detectOwnerLanguage } from '../orc/owner-completion-report.text.js';

/** URLs (plain and Slack `<url|label>`). */
const URL_RE = /<?https?:\/\/[^\s<>|]+(?:\|[^>]*)?>?/gi;
/** `PR #1138`, `PR 1138`, `pull request #1138`. */
const PR_RE = /\b(?:PR|pull\s+request)\s*#?\s*(\d{1,7})\b/gi;
/** A bare `#1138` (two digits or more). */
const HASH_NUM_RE = /(?<![\w&])#(\d{2,7})\b/g;
/** Ticket and decision ids: `CREW-646`, `APP-12`, `D-822`. Single-letter prefixes other than D (H-1B) are words. */
const TICKET_RE = /\b(?:[A-Z][A-Z0-9]{1,9}|D)-\d{1,6}\b/g;
/** `GOAL:` / `Goal -` prefixes. */
const GOAL_RE = /\bgoal\s*[:：-]\s*/gi;
/** `worktree crewly-projects/wt-x`, `branch fix/foo`. */
const WORKTREE_RE = /\b(?:in\s+|on\s+)?(?:the\s+)?(?:git\s+)?(?:worktrees?|branch(?:es)?)\s*[:：]?\s*[`'"]?[\w./~@-]+[`'"]?(?:…|\.{3})?/gi;
/** Branch names with a conventional prefix: `fix/decision-card-wording`. */
const BRANCH_RE = /\b(?:feat|feature|fix|bugfix|hotfix|chore|docs|refactor|test|release|wip)\/[\w./-]+/gi;
/** `wt-crew257`-style worktree directory names. */
const WT_RE = /\bwt-[\w.-]+/gi;
/** Absolute / home / relative paths. */
const PATH_RE = /(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+\/?|\b[\w.@-]+(?:\/[\w.@-]+){2,}\/?/g;
/** Marks where a reference was removed (so only prepositions left dangling by a removal are dropped). */
const GAP = '\u0000';
/** A preposition (or "the") right before a removed reference that ended its phrase: "in <path>?" → "?". */
const DANGLING_PREP_RE = new RegExp(`\\b(?:in|at|on|from|to|into|onto|of|for|with|via|under|the|see)\\s*${GAP}(?=[\\s${GAP}]*(?:[?？.。!！,，;；:：)）—–-]|$))`, 'gi');
/** Backtick code spans. */
const CODE_RE = /`[^`]*`/g;

/** Result of {@link stripInternalRefs}. */
export interface StrippedText {
  /** The text without internal references (one line, tidied) */
  text: string;
  /** PR references and links that were taken out, for a details line */
  refs: string[];
}

/**
 * Take ticket ids, PR numbers, links, branch / worktree names, paths and
 * `GOAL:` prefixes out of a question or title (crewly#1367).
 *
 * @param raw - Question or title
 * @returns The plain text, and the PR references / links removed
 *
 * @example
 * ```typescript
 * stripInternalRefs('CREW-646 · GOAL: Merge PR #1138 (Gmail approve card)?');
 * // { text: 'Merge (Gmail approve card)?', refs: ['PR #1138'] }
 * ```
 */
export function stripInternalRefs(raw: string | undefined | null): StrippedText {
  const refs: string[] = [];
  const addRef = (r: string): void => {
    if (!refs.includes(r)) refs.push(r);
  };
  let t = String(raw ?? '').replace(/\s+/g, ' ');
  t = t.replace(URL_RE, (m) => {
    addRef(m.replace(/^</, '').replace(/>$/, '').split('|')[0]);
    return ` ${GAP} `;
  });
  t = t.replace(CODE_RE, (m) => (/[/#]|\b[A-Z]{2,}-\d/.test(m) ? ` ${GAP} ` : m.replace(/`/g, '')));
  t = t.replace(PR_RE, (_m, n: string) => {
    addRef(`PR #${n}`);
    return ` ${GAP} `;
  });
  t = t.replace(HASH_NUM_RE, (_m, n: string) => {
    addRef(`PR #${n}`);
    return ` ${GAP} `;
  });
  const gap = ` ${GAP} `;
  t = t
    .replace(GOAL_RE, ' ')
    .replace(WORKTREE_RE, gap)
    .replace(BRANCH_RE, gap)
    .replace(WT_RE, gap)
    .replace(PATH_RE, gap)
    .replace(TICKET_RE, gap);
  if (!t.includes(GAP) && t === String(raw ?? '').replace(/\s+/g, ' ')) return { text: t.trim(), refs };
  t = t.replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) t = t.replace(DANGLING_PREP_RE, GAP);
  return { text: tidy(t.split(GAP).join(' ')), refs };
}

/**
 * Tidy what stripping left: empty brackets, doubled separators, dangling
 * punctuation at the ends.
 *
 * @param s - Text
 * @returns One clean line
 */
function tidy(s: string): string {
  let t = s.replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/\(\s*[,;·:|]*\s*\)|（\s*[，,；;·：:|]*\s*）|\[\s*\]/g, ' ')
      .replace(/([(（])\s*[,;，；·|]+\s*/g, '$1')
      .replace(/\s*[,;，；·|]+\s*([)）])/g, '$1')
      .replace(/\s*([·|])\s*(?:[·|,;:]\s*)+/g, ' $1 ')
      .replace(/\s+([,;:，；：?？!！.。])/g, '$1')
      .replace(/([,;，；])(?:\s*[,;，；])+/g, '$1')
      .replace(/\s+/g, ' ');
  }
  return t
    .replace(/^[\s·|,;:：，；…—–-]+/u, '')
    .replace(/[\s·|,;:：，；—–-]+$/u, '')
    .replace(/\s*(?:…|\.{3})\s*$/u, '')
    .trim();
}

/** How many letters (any script) a text has. */
export function letterCount(s: string): number {
  return s.match(/\p{L}/gu)?.length ?? 0;
}

/** Words that make a question a merge question. */
const MERGE_RE = /\bmerg(?:e|es|ing)\b|合并|合入|合进/i;

/**
 * Whether an ask is about merging a PR: the question (before stripping) or
 * one of its options talks about merging. A card that only names a PR (to
 * close it, to review it) is not a merge card.
 *
 * @param rawQuestion - The question as the agent wrote it
 * @param options - Its options
 * @returns True for a merge card
 */
export function isMergeAsk(rawQuestion: string, options: ReadonlyArray<Pick<DecisionOption, 'label' | 'detail'>>): boolean {
  if (MERGE_RE.test(rawQuestion)) return true;
  return options.some((o) => MERGE_RE.test(`${o.label} ${o.detail ?? ''}`));
}

/**
 * Parse the optional card context. Each field is one short line.
 *
 * @param raw - `{requestedBy?, ownerLastSaid?, runtimeChanges?, link?}`
 * @returns The context, or undefined when empty
 * @throws Error (message for the agent) when a field is too long or not text
 */
export function parseDecisionContext(raw: unknown): DecisionContext | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('context must be an object: {"requestedBy": "...", "ownerLastSaid": "...", "runtimeChanges": "...", "link": "..."}.');
  const o = raw as Record<string, unknown>;
  const out: DecisionContext = {};
  for (const key of ['requestedBy', 'ownerLastSaid', 'runtimeChanges', 'link'] as const) {
    const v = o[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') throw new Error(`context.${key} must be text.`);
    const line = v.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const max = key === 'link' ? W.LINK_MAX_CHARS : W.CONTEXT_FIELD_MAX_CHARS;
    if (line.length > max) throw new Error(`context.${key} is too long (max ${max} characters): one short line the owner reads on a phone.`);
    out[key] = line;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Whether a question is written in the owner's language. Only a Chinese
 * owner is checked (an English owner reading a bilingual question is fine).
 *
 * @param question - The plain question
 * @param ownerLanguage - The owner's language, when known
 * @returns True when the question can go out as is
 */
export function questionFitsOwnerLanguage(question: string, ownerLanguage: DecisionLanguage | null | undefined): boolean {
  if (ownerLanguage !== 'zh') return true;
  return detectOwnerLanguage(question) === 'zh';
}

/** Generic English option labels, lower-cased with trailing punctuation removed, and their Chinese. */
const GENERIC_ZH: Readonly<Record<string, string>> = {
  yes: '好',
  'yes, do it': '好，去做',
  'do it': '去做',
  'go ahead': '去做',
  ok: '好',
  okay: '好',
  approve: '同意',
  no: '不用',
  'not now': '先不',
  'not yet': '先不',
  later: '以后再说',
  hold: '先放着',
  wait: '先等等',
  cancel: '取消',
  skip: '不用了',
  'remind me tomorrow': '明天再问',
};

/** Merge-card option labels and their Chinese. */
const MERGE_ZH: Readonly<Record<string, string>> = {
  yes: '合并',
  'yes, merge': '合并',
  'yes, merge it': '合并',
  'yes merge': '合并',
  merge: '合并',
  'merge it': '合并',
  'merge now': '合并',
  approve: '合并',
  ok: '合并',
  no: '先不合',
  'not now': '先不合',
  'not yet': '先不合',
  "don't merge": '先不合',
  'dont merge': '先不合',
  'do not merge': '先不合',
  hold: '先不合',
  wait: '先不合',
  close: '关掉这个 PR',
  'close it': '关掉这个 PR',
  'close the pr': '关掉这个 PR',
};

/**
 * The option label in the owner's language: generic English labels ("Yes",
 * "Not now", "Yes, merge") become Chinese for a Chinese owner; a merge card
 * names the outcome (合并 / 先不合). Any other label is left as written.
 *
 * @param label - Label as asked
 * @param lang - Owner language
 * @param merge - The card is a merge question
 * @returns Label to show (and to match replies against)
 */
export function localizeOptionLabel(label: string, lang: DecisionLanguage | undefined, merge = false): string {
  if (lang !== 'zh') return label;
  const k = label.toLowerCase().replace(/[.。!！]+$/u, '').trim();
  return (merge ? MERGE_ZH[k] : undefined) ?? GENERIC_ZH[k] ?? label;
}

/**
 * Localize every option label; keeps labels distinct (a collision keeps the
 * original label).
 *
 * @param options - Options
 * @param lang - Owner language
 * @param merge - Merge card
 * @returns Options with localized labels
 */
export function localizeOptions(options: DecisionOption[], lang: DecisionLanguage | undefined, merge = false): DecisionOption[] {
  if (lang !== 'zh') return options;
  const used = new Set<string>();
  return options.map((o) => {
    const next = localizeOptionLabel(o.label, lang, merge);
    const label = used.has(next.toLowerCase()) ? o.label : next;
    used.add(label.toLowerCase());
    return label === o.label ? o : { ...o, label };
  });
}

/**
 * A question clipped for a one-line reminder.
 *
 * @param q - Question
 * @param max - Max characters
 * @returns Clipped text
 */
export function clipQuestion(q: string, max: number = W.REMINDER_QUESTION_MAX_CHARS): string {
  const t = q.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The harness's own card text, per owner language. */
export interface CardText {
  remindButton: string;
  skipButton: string;
  details: string;
  requestedBy: string;
  ownerLastSaid: string;
  runtimeChanges: string;
  mergeRuntimeChanges: string;
  remindingAt: (when: string) => string;
  declineDefault: (when: string, label: string) => string;
  heldDefault: (when: string, label: string) => string;
  sensitive: (kind: string) => string;
  waitHold: string;
  goWithDefault: (when: string, label: string) => string;
  waitReminder: (at: string, q: string) => string;
  waitReminderMany: (at: string, n: number) => string;
  remindNow: (at: string, q: string) => string;
  sensitiveReask: (at: string, q: string, kind: string) => string;
  chose: (who: string, label: string, at: string) => string;
  answered: (who: string, words: string, at: string) => string;
  answeredInThread: (at: string) => string;
  parked: (id: string) => string;
  closed: (reason: string, at: string) => string;
  skipped: (who: string, at: string) => string;
  theOwner: string;
  defaultNoAnswerOpen: (when: string) => string;
  defaultNoAnswer: (when: string, verb: string, label: string) => string;
  defaultVerb: (name: string | null, settled: boolean) => string;
}

const SENSITIVE_ZH: Readonly<Record<string, string>> = {
  email: '对外发消息',
  publish: '公开发布',
  deploy: '上线部署',
  spend: '花钱',
};

const EN: CardText = {
  remindButton: 'Remind me tomorrow',
  skipButton: 'Skip',
  details: 'Details',
  requestedBy: 'Asked for by',
  ownerLastSaid: 'You said last',
  runtimeChanges: 'What it changes',
  mergeRuntimeChanges: 'What merging changes',
  remindingAt: (when) => `⏰ Reminding you ${when}.`,
  declineDefault: (when, label) => `Nothing is accepted until you answer. No answer by ${when}: ${label}.`,
  heldDefault: (when, label) => `Nothing happens without your OK. If no answer by ${when}, the answer is ${label}.`,
  sensitive: (kind) => `This needs your OK (${kind}); I won't go ahead without an answer.`,
  waitHold: 'Tap an answer or reply in this thread — I\'ll hold this until you do.',
  goWithDefault: (when, label) => `If no answer by ${when}, I'll go with ${label}.`,
  waitReminder: (at, q) => `${at}Still waiting on you: “${q}” — tap an answer on the card above, or reply here.`,
  waitReminderMany: (at, n) => `${at}Still waiting on you for ${n} questions in this thread — tap an answer on each card above, or reply here.`,
  remindNow: (at, q) => `${at}Reminder: “${q}” — tap an answer on the card above, or reply here.`,
  sensitiveReask: (at, q, kind) => `${at}Still need your answer: “${q}” — it needs your OK (${kind}), so I'm not going ahead without it. The card is above.`,
  chose: (who, label, at) => `✔ ${who} chose *${label}* · ${at}`,
  answered: (who, words, at) => `✔ ${who} answered: “${words}” · ${at}`,
  answeredInThread: (at) => `✔ Answered in thread · ${at}`,
  parked: (id) => `⏸ Parked — no answer, so I'm not going ahead. Answer from "Waiting on you" to reopen it. · ${id}`,
  closed: (reason, at) => `✓ Closed — ${reason} · ${at}`,
  skipped: (who, at) => `⤼ ${who} skipped this · ${at}`,
  theOwner: 'The owner',
  defaultNoAnswerOpen: (when) => `No answer by ${when} — still open.`,
  defaultNoAnswer: (when, verb, label) => `No answer by ${when}, so ${verb} "${label}".`,
  defaultVerb: (name, settled) => (settled ? `${name ?? 'I'} went with` : name ? `${name} will go with` : "I'll go with"),
};

const ZH: CardText = {
  remindButton: '明天再问',
  skipButton: '不用了',
  details: '详情',
  requestedBy: '谁提的',
  ownerLastSaid: '你上次说',
  runtimeChanges: '会带来的变化',
  mergeRuntimeChanges: '合并后会',
  remindingAt: (when) => `⏰ ${when} 再提醒你。`,
  declineDefault: (when, label) => `你回答之前什么都不会生效。${when} 前没回答：${label}。`,
  heldDefault: (when, label) => `没有你的同意什么都不会发生。${when} 前没回答就按「${label}」。`,
  sensitive: (kind) => `这件事需要你同意（${SENSITIVE_ZH[kind] ?? kind}），没有答复我不会继续。`,
  waitHold: '点一个选项，或在这个帖子里回复——你回答之前我先不动。',
  goWithDefault: (when, label) => `${when} 前没回答，我就按「${label}」。`,
  waitReminder: (at, q) => `${at}还在等你回复：「${q}」——点上面卡片里的选项，或直接在这里回复。`,
  waitReminderMany: (at, n) => `${at}这个帖子里还有 ${n} 个问题在等你回复——点上面卡片里的选项，或直接在这里回复。`,
  remindNow: (at, q) => `${at}提醒一下：「${q}」——点上面卡片里的选项，或直接在这里回复。`,
  sensitiveReask: (at, q, kind) => `${at}还需要你确认：「${q}」——这件事需要你同意（${SENSITIVE_ZH[kind] ?? kind}），没有答复我不会继续。卡片在上面。`,
  chose: (who, label, at) => `✔ ${who} 选了 *${label}* · ${at}`,
  answered: (who, words, at) => `✔ ${who} 回复：“${words}” · ${at}`,
  answeredInThread: (at) => `✔ 已在帖子里回复 · ${at}`,
  parked: (id) => `⏸ 没有答复，先不做。在「等你处理」里回答可以重新打开。 · ${id}`,
  closed: (reason, at) => `✓ 已关闭——${reason} · ${at}`,
  skipped: (who, at) => `⤼ ${who} 跳过了 · ${at}`,
  theOwner: '你',
  defaultNoAnswerOpen: (when) => `${when} 前没有回答——还开着。`,
  defaultNoAnswer: (when, verb, label) => `${when} 前没有回答，所以${verb}「${label}」。`,
  defaultVerb: (name, settled) => (settled ? `${name ?? '我'}按了` : `${name ?? '我'}会按`),
};

/**
 * The harness's card text in a language.
 *
 * @param lang - Owner language (absent = English)
 * @returns Strings
 */
export function cardText(lang: DecisionLanguage | undefined): CardText {
  return lang === 'zh' ? ZH : EN;
}

const DAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * Short local time in Chinese: "14:05" today, "明天 12:00", else "10月2日 周四 12:00".
 *
 * @param at - Moment
 * @param now - Clock
 * @returns Text
 */
export function formatWhenZh(at: Date, now: Date = new Date()): string {
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(at) === day(now)) return hm;
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day(at) === day(tomorrow)) return `明天 ${hm}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${DAYS_ZH[at.getDay()]} ${hm}`;
}

/**
 * The context lines of a card (who asked, what the owner said last, what
 * changes), as mrkdwn — null when there is no context.
 *
 * @param context - Card context
 * @param lang - Owner language
 * @param merge - Merge card ("What merging changes")
 * @returns mrkdwn, or null
 */
export function contextSection(context: DecisionContext | undefined, lang: DecisionLanguage | undefined, merge = false): string | null {
  if (!context) return null;
  const t = cardText(lang);
  const sep = lang === 'zh' ? '：' : ': ';
  const lines: string[] = [];
  if (context.requestedBy) lines.push(`*${t.requestedBy}*${sep}${context.requestedBy}`);
  if (context.ownerLastSaid) lines.push(`*${t.ownerLastSaid}*${sep}“${context.ownerLastSaid.replace(/^[“"「]+|[”"」]+$/gu, '')}”`);
  if (context.runtimeChanges) lines.push(`*${merge ? t.mergeRuntimeChanges : t.runtimeChanges}*${sep}${context.runtimeChanges}`);
  return lines.length ? lines.join('\n') : null;
}

/**
 * The short details line (PR link / references), or null.
 *
 * @param d - Decision context + stripped refs
 * @param lang - Owner language
 * @returns mrkdwn, or null
 */
export function detailsLine(d: { context?: DecisionContext; details?: string[] }, lang: DecisionLanguage | undefined): string | null {
  const refs = [...(d.context?.link ? [d.context.link] : []), ...(d.details ?? [])];
  const unique = refs.filter((r, i) => refs.indexOf(r) === i);
  // A link already names the PR: drop a bare "PR #n" it contains.
  const shown = unique.filter((r) => {
    const n = /^PR #(\d+)$/.exec(r)?.[1];
    return !n || !unique.some((o) => o !== r && new RegExp(`/pull/${n}\\b`).test(o));
  });
  if (shown.length === 0) return null;
  return `${cardText(lang).details}${lang === 'zh' ? '：' : ': '}${shown.slice(0, W.DETAILS_MAX_REFS).join(' · ')}`;
}
