/**
 * The one line the harness posts to the owner when an agent finished
 * owner-requested work and never reported it (crewly#1357).
 *
 * The owner thread is not a log: the line names the deliverable in plain
 * words, in the owner's language, with no work item ids, links, file names,
 * codecs, sizes or "Results:" dumps. On 2026-10-17 the fallback posted
 * "Ella finished: <WorkItem titles> Results: <PR link, codec, file sizes>"
 * into a video thread; the owner's reaction: 我还是收到agent发的这种message.
 *
 * Pure functions only.
 *
 * @module services/orc/owner-completion-report.text
 */

import { OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';

/** Languages the fallback line is written in. */
export type OwnerLanguage = 'en' | 'zh';

/** CJK ideographs, kana and hangul. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
/** Letters of any script (what the ratio is measured against). */
const LETTER_RE = /[\p{L}]/gu;
/** http(s) links, bare www. links and `<url|label>` Slack links. */
const URL_RE = /<?(?:https?:\/\/|www\.)[^\s<>|]+(?:\|[^>]*)?>?/gi;
/** UUIDs. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Short ids: 8+ hex chars (work item prefixes, commit shas). */
const HEX_ID_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
/** Ticket ids (`CREW-305`, `TKT-12`, `#1357`). */
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b|(?<![\w&])#\d{2,7}\b/g;
/** Paths: anything with a slash and no spaces that looks like a file / dir, plus `~/…` and `./…`. */
const PATH_RE = /(?:~|\.{1,2})?\/[\w.@~-]+(?:\/[\w.@~-]+)+\/?|\b[\w.-]+\/[\w./-]*\.[a-z0-9]{1,6}\b/gi;
/** Bare file names with a known extension (`clip.mp4`, `notes.md`). */
const FILE_RE = /\b[\w-]+\.(?:mp4|mov|webm|mkv|gif|png|jpe?g|svg|pdf|md|txt|csv|json|ya?ml|html?|tsx?|jsx?|sh|zip|docx?|xlsx?|pptx?)\b/gi;
/** Parentheses (ASCII and full-width) with their content. */
const PARENS_RE = /\(([^()]*)\)|（([^（）]*)）/g;
/** Backtick code spans. */
const CODE_RE = /`[^`]*`/g;
/** Status markers such as `[DONE]`. */
const MARKER_RE = /\[[A-Z_ ]{2,20}\]/g;
/** Where the first clause ends. */
const CLAUSE_END_RE = /(?:\.\s|。|;|；|\s[—–-]\s|\n|:\s|：)/;
/** Leftover punctuation at the ends. */
const EDGE_PUNCT_RE = /^[\s,.;:!?、，。；：—–\-"'“”‘’(（)）]+|[\s,.;:!?、，。；：—–\-"'“”‘’(（)）]+$/g;
/** Trailing words a stripped sentence may leave dangling. */
const DANGLING_RE = /\s+(?:in|at|to|for|of|on|from|with|under|into|via|as|by|and|or|的|在|到|于)$/i;

/**
 * Which language the owner writes in, from a sample of their text: Chinese
 * when at least {@link OWNER_COMPLETION_REPORT_CONSTANTS.OWNER_LANGUAGE_CJK_MIN_RATIO}
 * of its letters are CJK, else English. An empty sample is English.
 *
 * @param sample - The owner's own words (one or several messages)
 * @returns `zh` or `en`
 *
 * @example
 * ```typescript
 * detectOwnerLanguage('什么是投资'); // 'zh'
 * detectOwnerLanguage('Record a short demo'); // 'en'
 * ```
 */
export function detectOwnerLanguage(sample: string | readonly string[] | null | undefined): OwnerLanguage {
  const text = Array.isArray(sample) ? sample.join('\n') : String(sample ?? '');
  const letters = text.match(LETTER_RE)?.length ?? 0;
  if (!letters) return 'en';
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return cjk / letters >= C.OWNER_LANGUAGE_CJK_MIN_RATIO ? 'zh' : 'en';
}

/**
 * The deliverable a work item title or summary names, in plain words: its
 * first clause with links, ids, paths, file names, code spans, markers and
 * parentheses holding digits removed.
 *
 * @param text - Title or summary
 * @returns The plain phrase (possibly empty), at most {@link OWNER_COMPLETION_REPORT_CONSTANTS.DELIVERABLE_MAX_CHARS} characters
 *
 * @example
 * ```typescript
 * plainDeliverable('Screen recording of the tutorial page (1080p, 42 MB) — https://x.test/a.mp4');
 * // 'Screen recording of the tutorial page'
 * ```
 */
export function plainDeliverable(text: string | undefined | null): string {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(MARKER_RE, ' ').replace(CODE_RE, ' ').replace(URL_RE, ' ');
  // An aside that held a number or something internal (a file, an id) is an
  // aside the owner does not need; one that only held words stays.
  t = t.replace(PARENS_RE, (whole, ascii: string | undefined, wide: string | undefined) => {
    const inner = (ascii ?? wide ?? '').trim();
    const cleaned = stripInternal(inner).trim();
    return /\d/.test(inner) || !cleaned || cleaned !== inner ? ' ' : whole;
  });
  const clause = t.split(CLAUSE_END_RE)[0] ?? '';
  t = stripInternal(clause)
    .replace(/\s+/g, ' ')
    .replace(EDGE_PUNCT_RE, '')
    .trim();
  // Stripping can leave "Fix for and" behind: drop dangling connectives until none is left.
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(DANGLING_RE, '').replace(EDGE_PUNCT_RE, '').trim();
  }
  if (t.length > C.DELIVERABLE_MAX_CHARS) t = `${t.slice(0, C.DELIVERABLE_MAX_CHARS - 1).trimEnd()}…`;
  return t;
}

/**
 * Remove what is internal to the harness from a phrase: ids, paths, file
 * names, ticket ids and short hex ids.
 *
 * @param text - Phrase
 * @returns The phrase without them (spacing not yet normalised)
 */
function stripInternal(text: string): string {
  return text.replace(UUID_RE, ' ').replace(PATH_RE, ' ').replace(FILE_RE, ' ').replace(TICKET_RE, ' ').replace(HEX_ID_RE, ' ');
}

/**
 * The deliverables of a chain, de-duplicated, at most
 * {@link OWNER_COMPLETION_REPORT_CONSTANTS.MAX_TITLES}.
 *
 * @param texts - Titles / summaries of the finished work, in order
 * @returns Plain phrases (possibly empty)
 */
export function plainDeliverables(texts: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const phrase = plainDeliverable(text);
    if (phrase && !out.some((p) => p.toLowerCase() === phrase.toLowerCase())) out.push(phrase);
    if (out.length >= C.MAX_TITLES) break;
  }
  return out;
}

/**
 * The deliverables of a chain written in the owner's language, plain-worded.
 * A phrase in another language is left out: a Chinese line never embeds an
 * English WorkItem title ("Atlas 做完了Website-plan PDF built and posted in
 * Steve thread", crewly#1376), and the line then names no deliverable.
 *
 * @param texts - Titles / summaries of the finished work, in order
 * @param language - The owner's language
 * @returns Plain phrases in that language (possibly none)
 */
export function plainDeliverablesIn(texts: readonly (string | undefined | null)[], language: OwnerLanguage): string[] {
  return plainDeliverables(texts).filter((phrase) => detectOwnerLanguage(phrase) === language);
}

/**
 * Join phrases the way the language does ("a, b and c" / "a、b和c").
 *
 * @param phrases - Plain phrases
 * @param language - Owner language
 * @returns One list phrase
 */
export function joinDeliverables(phrases: readonly string[], language: OwnerLanguage): string {
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return phrases[0];
  const head = phrases.slice(0, -1);
  const last = phrases[phrases.length - 1];
  return language === 'zh' ? `${head.join('、')}和${last}` : `${head.join(', ')} and ${last}`;
}

/** Inputs of {@link fallbackLine}. */
export interface FallbackLineInput {
  /** The responsible agent's display name */
  agentName: string;
  /** Titles / summaries of the finished work */
  deliverables: readonly (string | undefined | null)[];
  /** The owner's language */
  language: OwnerLanguage;
}

/**
 * The one sentence posted for the agent, plus the short "sent by Crewly"
 * marker, in the owner's language. It names only deliverables written in
 * that language and promises nothing: "details later" was a promise nobody
 * owned (crewly#1376).
 *
 * @param input - Agent name, deliverables, language
 * @returns Two lines: the sentence and the marker
 *
 * @example
 * ```typescript
 * fallbackLine({ agentName: 'Ella', deliverables: ['排期里 5 张卡的文案', '教程页的录屏'], language: 'zh' });
 * // 'Ella 做完了排期里 5 张卡的文案和教程页的录屏。\n— 由 Crewly 代发'
 * ```
 */
export function fallbackLine(input: FallbackLineInput): string {
  const what = joinDeliverables(plainDeliverablesIn(input.deliverables, input.language), input.language);
  if (input.language === 'zh') {
    const sentence = what ? `${input.agentName} 做完了${what}。` : `${input.agentName} 把你要的事做完了。`;
    return `${sentence}\n— 由 Crewly 代发`;
  }
  const sentence = what ? `${input.agentName} finished ${what}.` : `${input.agentName} finished what you asked for.`;
  return `${sentence}\n— sent by Crewly`;
}

/** Inputs of {@link leadFallbackLine}. */
export interface LeadFallbackLineInput {
  /** Who did the work (display name) */
  workerName: string;
  /** Titles / summaries of the finished work */
  deliverables: readonly (string | undefined | null)[];
  /** The owner's language */
  language: OwnerLanguage;
  /** Link to the thread the owner approved it in, when it is a Slack thread */
  approvalLink?: string | null;
}

/**
 * The line the harness posts in the team channel, as the team lead, when the
 * lead never reported team work the orchestrator delegated for the owner
 * (crewly#1371): who finished what the owner approved, and where the owner
 * approved it; plus the short "sent by Crewly" marker.
 *
 * @param input - Worker name, deliverables, language, approval link
 * @returns The lines
 *
 * @example
 * ```typescript
 * leadFallbackLine({ workerName: 'Dana', deliverables: ['两个账号的教程文案'], language: 'zh', approvalLink: 'https://slack.com/archives/D1/p1' });
 * // 'Dana 做完了你批准的两个账号的教程文案。\n批准的对话：https://slack.com/archives/D1/p1\n— 由 Crewly 代发'
 * ```
 */
export function leadFallbackLine(input: LeadFallbackLineInput): string {
  const what = joinDeliverables(plainDeliverablesIn(input.deliverables, input.language), input.language);
  const link = input.approvalLink?.trim();
  if (input.language === 'zh') {
    const sentence = what ? `${input.workerName} 做完了你批准的${what}。` : `${input.workerName} 把你批准的事做完了。`;
    return [sentence, ...(link ? [`批准的对话：${link}`] : []), '— 由 Crewly 代发'].join('\n');
  }
  const sentence = what ? `${input.workerName} finished ${what}, which you approved.` : `${input.workerName} finished what you approved.`;
  return [sentence, ...(link ? [`Where you approved it: ${link}`] : []), '— sent by Crewly'].join('\n');
}
