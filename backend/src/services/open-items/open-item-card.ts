/**
 * Turn a question an agent asked the owner in its reply into a decision card
 * (specs/2026-10-01-reply-open-items.md §4). Pure.
 *
 * - A stated fallback decides the default: "不同意的话我就删掉，只留事实" →
 *   options Yes / No (No = "删掉，只留事实"), default No — what the agent said
 *   it would do without an answer. "没意见的话我就发" → default Yes.
 * - "A 还是 B？" / "Should I A or B?" → options A and B, default wait.
 * - Anything else → Yes / No / Reply in thread, default wait.
 *
 * Option labels the harness writes are English; the agent's own words stay
 * as they are (in an option's label or detail).
 *
 * @module services/open-items/open-item-card
 */

import { DECISION_CONSTANTS, OPEN_ITEMS_CONSTANTS } from '../../constants.js';
import type { DecisionOption, DecisionSensitiveKind } from '../../types/decision.types.js';
import type { ExtractedQuestion } from './open-item-extractor.js';
import { readsAsEitherOr } from '../decisions/decision-contract.js';

/** The card to post for a question. */
export interface DerivedQuestionCard {
  /** One line */
  question: string;
  options: DecisionOption[];
  /** Option key or `wait` */
  defaultKey: string;
  /** Option a plain "yes" / ✅ picks */
  yesKey?: string;
  sensitive?: DecisionSensitiveKind;
  /** How the options were found */
  derivedFrom: 'fallback_no' | 'fallback_yes' | 'choice' | 'generic';
  /**
   * What the question is about, shown under it: the owner's ask, the agent's
   * words around it, the draft it points at, a link to the full message —
   * mrkdwn sections ({@link questionContextBlocks})
   */
  context?: string[];
}

const KEYS = ['a', 'b', 'c', 'd', 'e'];

/** "If not, I'll …" — what happens on a no (Chinese / English). */
const FALLBACK_NO: RegExp[] = [
  /^(?:如果|要是)?(?:你|您)?(?:觉得)?(?:不同意|不认同|不行|不要|不需要|不用|不合适|不妥|不喜欢|不OK|不ok|不好)的话[，,\s]*(?:那)?(?:我)?(?:就|会|再|先)?(.+)$/iu,
  /^(?:否则|不然)(?:的话)?[，,\s]*(?:那)?(?:我)?(?:就|会)?(.+)$/u,
  /^(?:if not|if you don'?t (?:agree|want (?:it|that|this|to)|like (?:it|that))|if you disagree|otherwise),?\s*(?:i'?ll|i will|i'?d|we'?ll)\s+(.+)$/i,
];

/** "If no objection, I'll …" — what happens on a yes / by default. */
const FALLBACK_YES: RegExp[] = [
  /^(?:如果|要是)?(?:你|您)?(?:觉得)?(?:没意见|没问题|同意|可以|OK|ok|没异议|不反对|行)的话[，,\s]*(?:那)?(?:我)?(?:就|会)?(.+)$/iu,
  /^(?:if (?:i don'?t hear back|there'?s no objection|you don'?t object|no objection|that works|you agree)|unless you object),?\s*(?:i'?ll|i will|we'?ll)\s+(.+)$/i,
];

/**
 * Tidy an action phrase for an option detail.
 *
 * @param s - Raw phrase
 * @returns Phrase without the closing punctuation
 */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[。.!！;；]+$/u, '').trim();
}

/**
 * Clip to the option detail limit.
 *
 * @param s - Text
 * @returns Clipped text
 */
function detail(s: string): string {
  const max = DECISION_CONSTANTS.OPTION_DETAIL_MAX_CHARS;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The two alternatives of a choice question, when each fits on a button.
 *
 * @param q - Question sentence
 * @returns [A, B] or null
 */
export function choiceAlternatives(q: string): [string, string] | null {
  const max = DECISION_CONSTANTS.OPTION_LABEL_MAX_CHARS;
  const t = q.trim();
  const en = /^(?:should (?:i|we)|shall (?:i|we)|do you want (?:me|us) to|would you (?:prefer|like (?:me|us) to)|do you prefer)\s+(.+?),?\s+or\s+(.+?)\s*\?$/i.exec(t);
  if (en) {
    const a = tidy(en[1]);
    const b = tidy(en[2]);
    return a && b && a.length <= max && b.length <= max && a.toLowerCase() !== b.toLowerCase() ? [a, b] : null;
  }
  if (!/还是/.test(t)) return null;
  // The clause holding 还是: "…，你想先发 A 还是 B？" → "先发 A" / "B".
  // "要现在先发文字版，还是等图好了再发？": A may sit in the clause before.
  const clauses = t.replace(/[？?]\s*$/u, '').split(/[，,：:；;]/).map((c) => c.trim());
  const i = clauses.findIndex((c) => c.includes('还是'));
  if (i < 0) return null;
  let rawA: string | undefined;
  let rawB: string | undefined;
  if (clauses[i].startsWith('还是') && i > 0) {
    rawA = clauses[i - 1];
    rawB = clauses[i].slice(2);
  } else {
    [rawA, rawB] = clauses[i].split('还是');
  }
  if (rawA === undefined || rawB === undefined) return null;
  const a = tidy(rawA.replace(/^(?:那)?(?:你|您)?(?:觉得|想|要|看)?(?:是)?(?:要|用|选|先)?/u, ''));
  const b = tidy(rawB.replace(/(?:呢|吗|吧|啊|好|比较好|更好)+$/u, ''));
  if (!a || !b || a === b) return null;
  return a.length <= max && b.length <= max ? [a, b] : null;
}

/** Opening words of a question that are not part of the alternative itself. */
const LEAD_STRIP = /^(?:还是|或者是?|或是|要我|要不要|我要不要|我是否|是否要?|(?:or\s+)?(?:should|shall) (?:i|we)|(?:or\s+)?(?:do you want|would you like) (?:me|us) to|or\b,?)\s*/i;

/**
 * The short button label of one question of an either/or:
 * "还是先按现在的版本试一周再看？" → "先按现在的版本试一周再看".
 *
 * @param question - The question sentence
 * @returns Label (≤ 40 characters), or '' when nothing is left
 */
export function alternativeLabel(question: string): string {
  let t = question.trim().replace(/[？?!！。.\s]+$/u, '');
  for (let i = 0; i < 3; i++) {
    const next = t.replace(LEAD_STRIP, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/(?:吗|呢|吧|好吗|可以吗)+$/u, '').trim();
  const max = DECISION_CONSTANTS.OPTION_LABEL_MAX_CHARS;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Group consecutive questions of one reply that are alternatives of each
 * other: the later one starts with 还是 / 或者 / 或是 / "or", or the earlier
 * ends in an either/or clause (and is not already a complete "A 还是 B"
 * question). Groups hold at most 4 alternatives with distinct labels.
 *
 * @param questions - Questions in reply order
 * @returns Groups (a lone question is a group of one)
 */
export function groupEitherOr(questions: ExtractedQuestion[]): ExtractedQuestion[][] {
  const groups: ExtractedQuestion[][] = [];
  for (const q of questions) {
    const cur = groups[groups.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && cur.length < 4 && readsAsEitherOr(prev.text, q.text) && !(choiceAlternatives(prev.text) && !/^\s*(?:还是|或者|或是|or\s)/i.test(q.text))) {
      const labels = [...cur, q].map((x) => alternativeLabel(x.text).toLowerCase());
      if (labels.every(Boolean) && new Set(labels).size === labels.length) {
        cur.push(q);
        continue;
      }
    }
    groups.push([q]);
  }
  return groups;
}

/**
 * One card for questions that are alternatives: one button per alternative
 * (single choice) plus "Reply in thread". Default `wait`.
 *
 * @param qs - Two or more questions of a group from {@link groupEitherOr}
 * @returns Card fields; each option carries its full question
 */
export function deriveEitherOrCard(qs: ExtractedQuestion[]): DerivedQuestionCard {
  const C = OPEN_ITEMS_CONSTANTS;
  const max = DECISION_CONSTANTS.QUESTION_MAX_CHARS;
  const joined = qs.map((x) => x.text.replace(/\s+/g, ' ').trim()).join(' ');
  const sensitive = sensitiveKindOf(joined);
  return {
    question: joined.length > max ? `${joined.slice(0, max - 1)}…` : joined,
    ...(sensitive ? { sensitive } : {}),
    options: [
      ...qs.map((x, i) => ({ key: KEYS[i], label: alternativeLabel(x.text), question: x.text })),
      { key: KEYS[qs.length], label: C.REPLY_LABEL, detail: "you'll answer in words in this thread" },
    ],
    defaultKey: DECISION_CONSTANTS.WAIT_DEFAULT,
    derivedFrom: 'choice',
  };
}

/**
 * Which approval boundary a question touches (never auto-applied), if any.
 *
 * @param text - Question and fallback
 * @returns Sensitive kind, or undefined
 */
export function sensitiveKindOf(text: string): DecisionSensitiveKind | undefined {
  const t = text.toLowerCase();
  if (/\be-?mail\b|邮件|发信/.test(t)) return 'email';
  if (/\bdeploy|\bproduction\b|\bprod\b|部署|上生产|上线/.test(t)) return 'deploy';
  if (/\bpay\b|\bpurchase\b|\bbuy\b|\bsubscri|\bcharge|付款|付费|花钱|购买|订阅|扣费/.test(t)) return 'spend';
  if (/\bpublish|\bpost (?:it )?publicly\b|\btweet\b|公开发布|发布出去|发出去|发帖/.test(t)) return 'publish';
  return undefined;
}

/**
 * Build the card for a question.
 *
 * @param q - The question (and its fallback sentence)
 * @returns Card fields
 *
 * @example
 * deriveQuestionCard({ type: 'question', text: '这个读法，你同意吗？', fallback: '不同意的话我就删掉，只留事实。' })
 * // → options Yes / No ("删掉，只留事实"), default b (No), yesKey a
 */
export function deriveQuestionCard(q: ExtractedQuestion): DerivedQuestionCard {
  const C = OPEN_ITEMS_CONSTANTS;
  const question = q.text;
  const sensitive = sensitiveKindOf(`${q.text} ${q.fallback ?? ''}`);
  const base = { question, ...(sensitive ? { sensitive } : {}) };
  const fb = q.fallback?.trim();
  if (fb) {
    for (const re of FALLBACK_NO) {
      const m = re.exec(fb);
      if (m && tidy(m[1])) {
        return {
          ...base,
          options: [
            { key: 'a', label: C.YES_LABEL },
            { key: 'b', label: C.NO_LABEL, detail: detail(tidy(m[1])) },
          ],
          defaultKey: 'b',
          yesKey: 'a',
          derivedFrom: 'fallback_no',
        };
      }
    }
    for (const re of FALLBACK_YES) {
      const m = re.exec(fb);
      if (m && tidy(m[1])) {
        return {
          ...base,
          options: [
            { key: 'a', label: C.YES_LABEL, detail: detail(tidy(m[1])) },
            { key: 'b', label: C.NO_LABEL },
          ],
          defaultKey: 'a',
          yesKey: 'a',
          derivedFrom: 'fallback_yes',
        };
      }
    }
  }
  const alt = choiceAlternatives(q.text);
  if (alt) {
    return {
      ...base,
      options: alt.map((label, i) => ({ key: KEYS[i], label })),
      defaultKey: DECISION_CONSTANTS.WAIT_DEFAULT,
      derivedFrom: 'choice',
    };
  }
  return {
    ...base,
    options: [
      { key: 'a', label: C.YES_LABEL },
      { key: 'b', label: C.NO_LABEL },
      { key: 'c', label: C.REPLY_LABEL, detail: "you'll answer in words in this thread" },
    ],
    defaultKey: DECISION_CONSTANTS.WAIT_DEFAULT,
    yesKey: 'a',
    derivedFrom: 'generic',
  };
}

/**
 * Character-bigram overlap of two questions (Dice coefficient), ignoring
 * spaces and punctuation. Used to tell "the agent asked this through
 * ask-owner already".
 *
 * @param a - Question
 * @param b - Question
 * @returns 0..1
 */
export function questionSimilarity(a: string, b: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  const total = Math.max(1, x.length - 1) + Math.max(1, y.length - 1);
  return (2 * overlap) / total;
}

/**
 * Whether a question points back at earlier text ("这样安排行不行？", "Does
 * this plan work?") and so needs context to stand on its own.
 *
 * @param question - The question sentence
 * @returns True when it refers back
 */
export function refersBack(question: string): boolean {
  return OPEN_ITEMS_CONSTANTS.REFERS_BACK_PATTERNS.some((re) => re.test(question));
}

/**
 * Clip to a limit, keeping the END (the part closest to the question).
 *
 * @param s - Text
 * @param max - Limit
 * @returns Clipped text
 */
function clipTail(s: string, max: number): string {
  return s.length > max ? `…${s.slice(s.length - (max - 1))}` : s;
}

/**
 * Clip to a limit, keeping the start.
 *
 * @param s - Text
 * @param max - Limit
 * @returns Clipped text
 */
function clipHead(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Where the question sits in the message: the exact text, else its first
 * dozen characters (the extractor clips long questions).
 *
 * @param content - The agent message
 * @param question - The question sentence
 * @returns Index, or -1
 */
function questionIndex(content: string, question: string): number {
  const exact = content.indexOf(question);
  if (exact >= 0) return exact;
  const head = question.trim().slice(0, 12);
  return head ? content.indexOf(head) : -1;
}

/** A fenced (```) or quoted (`>` lines) block of a message. */
interface MessageBlock {
  start: number;
  end: number;
  kind: 'fenced' | 'quoted';
  /** Inner text (fences / `>` markers removed) */
  inner: string;
}

/**
 * The fenced and quoted blocks of a message, in order.
 *
 * @param content - The agent message
 * @returns Blocks
 */
function messageBlocks(content: string): MessageBlock[] {
  const out: MessageBlock[] = [];
  const fence = /```[^\n]*\n?([\s\S]*?)```/g;
  for (let m = fence.exec(content); m; m = fence.exec(content)) {
    if (m[1].trim()) out.push({ start: m.index, end: m.index + m[0].length, kind: 'fenced', inner: m[1].replace(/\s+$/, '') });
  }
  const quoted = /(?:^|\n)((?:[ \t]*(?:>|＞)[^\n]*(?:\n|$))+)/g;
  for (let m = quoted.exec(content); m; m = quoted.exec(content)) {
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    const end = start + m[1].length;
    if (out.some((b) => b.kind === 'fenced' && start >= b.start && start < b.end)) continue;
    const inner = m[1]
      .split('\n')
      .map((l) => l.replace(/^[ \t]*(?:>|＞)[ \t]?/u, ''))
      .join('\n')
      .trim();
    if (inner.replace(/[\s\p{P}\p{S}]+/gu, '').length >= 8) out.push({ start, end, kind: 'quoted', inner });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Quote text as mrkdwn `>` lines.
 *
 * @param t - Text
 * @returns Quoted text
 */
function quote(t: string): string {
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `> ${l}`)
    .join('\n');
}

/**
 * Meaningful length of a text (letters / digits / CJK only).
 *
 * @param t - Text
 * @returns Count
 */
function meaningful(t: string): number {
  return t.replace(/[\s\p{P}\p{S}]+/gu, '').length;
}

/** Input to {@link questionContextBlocks}. */
export interface QuestionContextInput {
  /** The agent message */
  content: string;
  /** The question sentence lifted out of it */
  question: string;
  /** The owner's original ask (the request's description, else its title) */
  ownerAsk?: string;
  /** Display name of the asking agent */
  agentName?: string;
  /** Link to the agent's full message in Slack, when it was posted there */
  messageLink?: string;
  /** Whether {@link messageLink} points at the thread rather than the message itself */
  linkIsThread?: boolean;
  /** Link to the ticket's old thread, when the card is posted somewhere else */
  oldThreadLink?: string;
}

/**
 * The context every auto-extracted question card carries, as mrkdwn sections
 * (specs/2026-10-02-decision-card-thread-answers.md §5). A question lifted
 * out of a message must stand on its own, wherever the card lands:
 *
 * - `*About:*` — the owner's original ask, clipped;
 * - the agent's words before the question (its last paragraph(s), up to
 *   ~500 characters), quoted;
 * - the fenced / quoted block (a draft) the question points at — "按这个草稿回？"
 *   — up to ~1200 characters;
 * - a link to the agent's full message (or "in Crewly chat"), and to the old
 *   ticket thread when the card is posted elsewhere.
 *
 * With nothing quotable, the card still says what it is about and how to
 * find out more: "Context: <ask> — reply in thread to ask <agent> for details".
 *
 * @param input - The agent message, the question, and where things are
 * @returns Sections (never empty)
 *
 * @example
 * questionContextBlocks({ content: '方案：Nova 负责 CE 的 codex 任务。\n\n这样安排行不行？', question: '这样安排行不行？', ownerAsk: '加一个 codex agent', agentName: 'Orc' })
 * // → ['*About:* 加一个 codex agent', '_Orc wrote:_\n> 方案：Nova 负责 CE 的 codex 任务。', '_Full message in Crewly chat._']
 */
export function questionContextBlocks(input: QuestionContextInput): string[] {
  const C = OPEN_ITEMS_CONSTANTS;
  const name = input.agentName?.trim() || 'the agent';
  const content = input.content ?? '';
  const at = questionIndex(content, input.question);
  const qEnd = at >= 0 ? at + input.question.length : content.length;
  const pointsBack = refersBack(input.question);
  const aboutDraft = C.DRAFT_WORD_PATTERN.test(input.question);

  // The block (draft) the question points at: the nearest one before it, else the first after.
  const blocks = messageBlocks(content).filter((b) => at < 0 || b.end <= at || b.start >= qEnd);
  const block = pointsBack || aboutDraft ? ([...blocks].reverse().find((b) => at < 0 || b.end <= at) ?? blocks.find((b) => b.start >= qEnd)) : undefined;

  // The agent's words before the question, without the block itself.
  let before = at >= 0 ? content.slice(0, at) : '';
  if (block && block.end <= at) before = `${before.slice(0, block.start)}\n\n${before.slice(block.end)}`;
  // A pointing-back question wants the text right before it: when a block sits
  // between, the paragraph that introduces the block is still the nearest words.
  let excerpt = '';
  if (meaningful(before) >= 8) {
    const paragraphs = before.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let picked = paragraphs.pop() ?? '';
    while (paragraphs.length > 0 && picked.length < C.CONTEXT_EXCERPT_MAX_CHARS) {
      const prev = paragraphs.pop()!;
      if (picked.length + prev.length + 1 > C.CONTEXT_EXCERPT_MAX_CHARS) break;
      picked = `${prev}\n${picked}`;
    }
    excerpt = clipTail(picked, C.CONTEXT_EXCERPT_MAX_CHARS);
  }

  const ask = input.ownerAsk?.replace(/\s+/g, ' ').trim();
  const askLine = ask && ask !== input.question.trim() ? clipHead(ask, C.CONTEXT_ABOUT_MAX_CHARS) : '';
  const out: string[] = [];
  if (!excerpt && !block) {
    out.push(`*Context:* ${askLine || 'none in the message'} — reply in thread to ask ${name} for details`);
  } else {
    if (askLine) out.push(`*About:* ${askLine}`);
    if (excerpt) out.push(`_${name} wrote:_\n${quote(excerpt)}`);
    if (block) {
      const inner = clipHead(block.inner, C.CONTEXT_BLOCK_MAX_CHARS);
      out.push(block.kind === 'fenced' ? `\`\`\`\n${inner.replace(/`{3,}/g, "''")}\n\`\`\`` : quote(inner));
    }
  }
  const links: string[] = [];
  if (input.messageLink) links.push(`<${input.messageLink}|${input.linkIsThread ? `Open the thread with ${name}'s message` : `Open ${name}'s full message`}>`);
  else links.push('_Full message in Crewly chat._');
  if (input.oldThreadLink) links.push(`<${input.oldThreadLink}|Earlier ticket thread>`);
  out.push(links.join(' · '));
  return out;
}
