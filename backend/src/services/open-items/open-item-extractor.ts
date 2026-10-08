/**
 * Find the commitments and questions an agent left open in a reply to the
 * owner (specs/2026-10-01-reply-open-items.md §1). Pure, rules only.
 *
 * Tuned to miss rather than invent: a missed promise costs one follow-up the
 * owner has to ask for himself; an invented question puts a pointless card in
 * front of him. So a sentence only counts when it clearly says
 *
 * - **commitment**: a first-person future deliverable for the owner
 *   ("明天中午给我，我核过以后挑最有用的几条发你", "I'll send the draft tonight");
 * - **question**: a direct question that asks the owner to decide or confirm
 *   ("这个读法，你同意吗？", "Should I keep the appendix?") — and only the
 *   message's FINAL question (nothing but a fallback or a sign-off after it).
 *
 * Skipped on purpose: past tense ("已经发你了", "attached below"), conditional
 * offers ("要的话我再…", "if you want, I'll…"), quoted text, headings,
 * questions to a colleague (an @-mention or a teammate's name up front),
 * questions in a list or written for a third party (interview / survey
 * questions), questions in the middle of a message, and rhetorical questions
 * that the agent answers itself.
 *
 * @module services/open-items/open-item-extractor
 */

import { OPEN_ITEMS_CONSTANTS } from '../../constants.js';

/** A commitment found in a reply. */
export interface ExtractedCommitment {
  type: 'commitment';
  /** The sentence (clipped) */
  text: string;
  /** When it is due */
  due: Date;
  /** `text` = a time was said; `default` = none was, so +24 h */
  dueSource: 'text' | 'default';
  /** Conditional on the owner ("你点头后…"): no due time until they say yes */
  waitsOnOwner?: boolean;
}

/** A question to the owner found in a reply. */
export interface ExtractedQuestion {
  type: 'question';
  /** The question sentence (clipped, one line) */
  text: string;
  /** The sentence after it, when it states a fallback ("不同意的话我就删掉") */
  fallback?: string;
}

/** Everything found in one reply. */
export interface ExtractedOpenItems {
  commitments: ExtractedCommitment[];
  questions: ExtractedQuestion[];
}

/** Options for {@link extractOpenItems}. */
export interface ExtractOptions {
  /** When the reply was posted (due times are relative to it) */
  now: Date;
  /** Display names of the agent's colleagues (a question addressed to one is not for the owner) */
  colleagueNames?: readonly string[];
  /** The owner's Slack user id: an @-mention of anyone else makes a sentence not for the owner */
  ownerSlackUserId?: string;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** One sentence with the line it came from. */
interface Sentence {
  text: string;
  /** Index of the sentence within its line */
  index: number;
  /** All sentences of the same line */
  line: string[];
  /** The line was a list item (bullet or numbered) */
  listItem?: boolean;
  /** The prose line before this sentence's line (blank lines skipped), if any */
  prevLine?: string;
  /** Paragraph number (blank lines separate paragraphs) */
  para?: number;
}

/**
 * Lines that are not prose: headings, quotes, code.
 *
 * @param line - Trimmed line
 * @returns True to skip the line
 */
function isNonProseLine(line: string): boolean {
  if (/^(#{1,6}\s|>|```|\|)/.test(line)) return true;
  // A whole line in bold/italics is a heading ("*为什么是你？*").
  if (/^[*_]{1,2}[^*_]+[*_]{1,2}[:：]?$/.test(line)) return true;
  return false;
}

const OPEN_QUOTES = '「『“‘《（(';
const CLOSE_QUOTES = '」』”’》）)';

/**
 * Split one line into sentences at 。！？!?；; (and ". " before a capital or
 * CJK), never inside quotes or brackets, keeping each terminator.
 *
 * @param line - One line
 * @returns Sentences
 */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    cur += ch;
    if (OPEN_QUOTES.includes(ch)) depth += 1;
    else if (CLOSE_QUOTES.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    const next = chars[i + 1];
    const cut = '。！？!?；;'.includes(ch) || (ch === '.' && next === ' ' && /[A-Z\u4e00-\u9fff]/u.test(chars[i + 2] ?? ''));
    // Keep closing punctuation right after the terminator ("？）", "。」").
    if (cut && !(next && CLOSE_QUOTES.includes(next))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A block between two rule lines (a draft the agent wrote for someone else to send). */
const DRAFT_BLOCK = /^[ \t]*(?:-{3,}|—{2,}|_{3,}|\*{3,})[ \t]*$[\s\S]*?^[ \t]*(?:-{3,}|—{2,}|_{3,}|\*{3,})[ \t]*$/gmu;

/** A bullet or numbered list marker at the start of a line ("- ", "• ", "1. ", "2) ", "（3）", "3、"). */
const LIST_MARKER = /^\s*(?:[-*•·]\s+|\d+[.)、]\s*|[（(]\d+[）)]\s*)/u;

/**
 * Split a reply into sentences, line by line.
 *
 * @param text - Reply text
 * @returns Sentences
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  // Code, and a draft between two rule lines ("———" / "---"), are not the agent's words to the owner.
  const noCode = text.replace(/```[\s\S]*?```/g, ' ').replace(DRAFT_BLOCK, '\n\n');
  let prevLine: string | undefined;
  let para = 0;
  for (const raw of noCode.split(/\n/)) {
    const listItem = LIST_MARKER.test(raw);
    const line = raw.replace(LIST_MARKER, '').trim();
    if (!line) {
      para += 1;
      continue;
    }
    if (isNonProseLine(line)) {
      // A heading or quote still introduces what follows ("*问这几件事*").
      prevLine = line;
      continue;
    }
    const parts = splitLine(line);
    const before = prevLine;
    parts.forEach((p, i) => out.push({ text: p, index: i, line: parts, para, ...(listItem ? { listItem } : {}), ...(before ? { prevLine: before } : {}) }));
    prevLine = line;
  }
  return out;
}

/**
 * Whether the sentence's question mark sits inside quotes (a quoted question,
 * e.g. 早报里问你一句「你怎么看？」).
 *
 * @param s - Sentence
 * @returns True when every ?/？ is inside quotes
 */
function questionIsQuoted(s: string): boolean {
  let depth = 0;
  let unquoted = false;
  for (const ch of s) {
    if ('「『“‘《'.includes(ch)) depth += 1;
    else if ('」』”’》'.includes(ch)) depth = Math.max(0, depth - 1);
    else if ((ch === '?' || ch === '？') && depth === 0) unquoted = true;
  }
  return !unquoted;
}

/**
 * Clip to one line of at most `max` characters.
 *
 * @param s - Text
 * @param max - Max characters
 * @returns Clipped text
 */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').replace(/^[*_]+|[*_]+$/g, '').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Whether a sentence is addressed to someone other than the owner: an
 * @-mention of another user, or a colleague's name opening it ("Kai，你…").
 *
 * @param s - Sentence
 * @param opts - Colleague names, owner id
 * @returns True when it is for a colleague
 */
function addressedToColleague(s: string, opts: ExtractOptions): boolean {
  for (const m of s.matchAll(/<@([A-Z0-9]+)>/g)) {
    if (!opts.ownerSlackUserId || m[1] !== opts.ownerSlackUserId) return true;
  }
  if (/(^|\s)@[A-Za-z一-鿿][\w一-鿿-]*/u.test(s.replace(/<@[A-Z0-9]+>/g, ''))) return true;
  for (const name of opts.colleagueNames ?? []) {
    const n = name.trim();
    if (n.length < 2) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${esc}\\s*[,，:：]`, 'i').test(s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

/** A deliverable for the owner (Chinese): 发你 / 给你 / 告诉你 / 发在这里 … */
const ZH_DELIVER =
  /(?:发|给|交|传|带|拿|报|汇报|同步|告诉|通知|回复|回|贴|放|整理|写|做|出|补|帮)(?:一下|一份|一版|一个|几条|上来)?(?:给)?(?:你|您)(?![们的])|(?:发|贴|放|交)(?:在|到)(?:这里|这儿|这个线程|群里|频道)|(?:发|贴|交)上来|给你看|拿给你|报给你/u;

/** Future markers (Chinese). */
const ZH_FUTURE =
  /明天|明早|明晚|今晚|今天|后天|下周|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|稍后|待会|一会儿|回头|晚点|之后|以后|再|会|先|小时|分钟|中午|下午|晚上|早上|上午|[好完](?:以后|之后|后)|出来[后以]|核过|过一遍|一起/u;

/** Past / already-done markers (Chinese). */
const ZH_PAST = /之前说|刚才说|前面说|上面说|先前说|已经|已(?:发|放|附|写|改|存|同步|上传)|刚才|刚刚|附在|附上了|见下|如下|下面附|现在(?:先)?给(?:你|您)|这是|下面是|(?:你|您)了[，。！,.!]?$|(?:你|您)了[，,]/u;

/** Standing habits, not one deliverable: "以后每章都给你发 PDF", "from now on". */
const HABITUAL = /每(?:次|章|天|周|个|篇|期|回|晚|早)|以后都|今后|往后|所有|一律|都先|都按|照常|from now on|every (?:time|day|week|chapter)|each time/iu;

/** Conditional offers (Chinese): "要的话我再…", "如果你想…". */
const ZH_CONDITIONAL = /如果|要是|假如|的话|需要的话|想要的话/u;

/** First-person future deliverable (English). */
const EN_COMMIT =
  /\b(?:i'?ll|i will|i'm going to|i am going to|we'?ll|we will|i'?m gonna|i can have)\b[^.?!]{0,80}?\b(?:send|share|post|deliver|get back|circle back|follow up|report back|update you|let you know|bring|hand over|draft|write up|put together|wrap up|finish|have (?:it|this|that|them|the \w+)|get (?:it|this|that|them) to you)\b/i;

/** Conditional / past (English). */
const EN_SKIP = /\b(?:if|unless|otherwise|whenever|in case|already|attached|below|above|have sent|sent you|i'?d)\b/i;

/** Someone other than the agent's side does the delivering ("别人第二天白天回你"). */
const ZH_THIRD_PARTY = /^(?:别人|他们|她们|他|她|它|对方|大家|有人|读者|用户|客户|网友|粉丝|对面)/u;

/** "给你体检的那位医生": 给你/发你 inside a modifier ending in 的 is not a deliverable. */
const ZH_DELIVER_MODIFIER = /(?:发|给|交|传|带|拿|报|告诉|通知|回复|回|写|做|出|帮)(?:你|您)[^，。；,;！？]{0,8}的/gu;

/** The promise waits on the owner's say-so ("你点头后…", "once you approve…"): not due until they answer. */
const OWNER_GATE =
  /(?:你|您)(?:点头|同意|批准|确认|拍板|说可以|说行|答应)(?:后|以后|之后)|等(?:你|您)(?:点头|同意|批准|确认|拍板)|once you (?:approve|confirm|agree|say)|after you (?:approve|confirm|agree|say)|when you (?:approve|confirm|agree|say)/iu;

/** The sentence asks the owner for a go-ahead ("先问你：可以就让 Vera 做"): nothing is owed, it is a question. */
const ASKS_OWNER = /先问(?:你|您)|可以就让|可以的话我就|行的话我就|ok的话我就/iu;

/** A sentence that opens as a caveat or note about the work, not a deliverable ("要说清楚的地方：…", "note: …"). */
const CAVEAT = /^(?:\**\s*)?(?:要说清楚的地方|需要说明|需要注意|注意|提醒|补充一句|另外说明|note|caveat|heads up|fyi)\b|^(?:\**\s*)?(?:要说清楚的地方|需要说明|需要注意|注意|提醒|补充一句|另外说明)[*：:]/iu;

/**
 * Hedge words. They cancel a promise only inside the clause that holds the
 * deliverable ("可能需要明天再发你"); a hedge in another clause qualifies a
 * real promise ("明天发你清单，不一定全") and must not drop it (#925).
 */
const HEDGE = /不一定|不代表|可能需要|may need|might need/iu;

/** Clause boundaries: punctuation, and English contrast words. */
const CLAUSE_SPLIT = /[，,；;：:]|\s(?:though|although|but|however)\s/iu;

/**
 * Whether the clause that holds the deliverable is itself hedged.
 *
 * @param t - Sentence (quotes and asides removed)
 * @param deliver - The pattern that finds the deliverable in a clause
 * @returns True when a hedge word sits in that clause
 */
function deliverableIsHedged(t: string, deliver: RegExp): boolean {
  const clause = t.split(CLAUSE_SPLIT).find((c) => deliver.test(c));
  return !!clause && HEDGE.test(clause);
}

/**
 * Whether the clause holding the deliverable has a third party as subject.
 *
 * @param t - Sentence (quotes removed)
 * @returns True when someone outside the team delivers
 */
function thirdPartyDelivers(t: string): boolean {
  const clause = t.split(/[，,；;：:]/).find((c) => ZH_DELIVER.test(c));
  return !!clause && ZH_THIRD_PARTY.test(clause.trim());
}

/**
 * Whether a commitment sentence waits on the owner's say-so.
 *
 * @param s - A sentence {@link isCommitment} accepted
 * @returns True when it is conditional on the owner ("你点头后…")
 */
export function waitsOnOwner(s: string): boolean {
  return OWNER_GATE.test(s);
}

/**
 * Whether a sentence is a commitment to the owner.
 *
 * @param s - Sentence
 * @returns True for a first-person future deliverable
 */
export function isCommitment(s: string): boolean {
  // Quoted words are someone else's ("…原话：「10 分钟就给你做出…」").
  // So are bracketed asides ("（…Gemini 带你玩夏威夷…）").
  const t = s.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|（[^）]*）|\([^)]*\)/g, ' ').trim();
  if (/[?？]\s*$/.test(t)) return false;
  if (thirdPartyDelivers(t)) return false;
  if (HABITUAL.test(t)) return false;
  if (ASKS_OWNER.test(t) || CAVEAT.test(t)) return false;
  const unmodified = t.replace(ZH_DELIVER_MODIFIER, ' ');
  if (/[一-鿿]/.test(t) && ZH_DELIVER.test(unmodified)) {
    if (ZH_PAST.test(t) || ZH_CONDITIONAL.test(t)) return false;
    if (deliverableIsHedged(unmodified, ZH_DELIVER)) return false;
    return ZH_FUTURE.test(t);
  }
  if (EN_COMMIT.test(t)) return !EN_SKIP.test(t) && !deliverableIsHedged(t, EN_COMMIT);
  return false;
}

// ---------------------------------------------------------------------------
// Due times
// ---------------------------------------------------------------------------

const WEEKDAY_ZH: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WEEKDAY_EN: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/**
 * A local date `days` after `now` at `hour`:00.
 *
 * @param now - Clock
 * @param days - Days ahead
 * @param hour - Local hour
 * @returns Date
 */
function dayAt(now: Date, days: number, hour: number): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * The hour a part-of-day word names, or null.
 *
 * @param t - Lower-cased text
 * @returns Local hour
 */
function partOfDayHour(t: string): number | null {
  if (/中午|\bnoon\b|\blunch/.test(t)) return 12;
  if (/傍晚|下班|end of (?:the )?day|\beod\b/.test(t)) return 18;
  if (/下午|afternoon/.test(t)) return 15;
  if (/晚上|晚|evening|night|tonight/.test(t)) return 21;
  if (/早上|上午|早|morning/.test(t)) return 10;
  return null;
}

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date named in the text: 2026-10-07, 10/7, 10月7日/号, "Oct 7". Local time,
 * the part of day named (default 18:00); a date already past rolls to next year.
 *
 * @param s - Sentence
 * @param now - When it was said
 * @returns The date, or null
 */
function explicitDate(s: string, now: Date): Date | null {
  const t = s.toLowerCase();
  let y: number | undefined;
  let m: number | undefined;
  let d: number | undefined;
  let hit =
    /(?<![\d./])(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/.exec(t);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/.exec(t))) [m, d] = [Number(hit[1]), Number(hit[2])];
  else if ((hit = /(?<![\d./])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(t))) {
    // "1/3" is as likely a ratio: take a slash date only when it falls in the coming months.
    [m, d] = [Number(hit[1]), Number(hit[2])];
    const ahead = new Date(now.getFullYear(), m - 1, d, 12).getTime() - now.getTime();
    if (ahead < -24 * 3600_000 || ahead > 120 * 24 * 3600_000) return null;
  }
  else if ((hit = new RegExp(`\\b(${MONTHS_EN.join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\b`).exec(t))) [m, d] = [MONTHS_EN.indexOf(hit[1]) + 1, Number(hit[2])];
  if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const hour = partOfDayHour(t) ?? 18;
  let due = new Date(y ?? now.getFullYear(), m - 1, d, hour, 0, 0, 0);
  if (y === undefined && due.getTime() < now.getTime() - 24 * 3600_000) due = new Date(now.getFullYear() + 1, m - 1, d, hour, 0, 0, 0);
  return due;
}

/**
 * When a commitment is due.
 *
 * Rules (local time): an explicit date (10/7, 10月7日, 2026-10-07) wins over everything; an explicit day/part of day wins ("明天中午" → tomorrow
 * 12:00, "tonight" → today 21:00, "by Friday" → Friday 12:00); "tomorrow"
 * alone → tomorrow {@link OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_HOUR_LOCAL}:00;
 * "in 2 hours" → +2 h; nothing → +{@link OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_MS}.
 *
 * @param s - Sentence
 * @param now - When it was said
 * @returns Due time and whether the text named it
 */
export function parseDue(s: string, now: Date): { due: Date; source: 'text' | 'default' } {
  const t = s.toLowerCase();
  const defaultHour = OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_HOUR_LOCAL;
  const text = (due: Date): { due: Date; source: 'text' } => ({ due, source: 'text' });

  // An explicit date wins over every relative cue and over now + default.
  const dated = explicitDate(s, now);
  if (dated) return text(dated);

  const rel = /(\d+(?:\.\d+)?)\s*(?:个)?\s*(小时|hours?|hrs?|分钟|minutes?|mins?)/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const ms = /小时|hour|hr/.test(rel[2]) ? n * 3600_000 : n * 60_000;
    if (ms > 0) return text(new Date(now.getTime() + ms));
  }
  if (/半小时|half an hour/.test(t)) return text(new Date(now.getTime() + 1800_000));

  // "晚点" / "早点" mean later / sooner, not evening / morning.
  const part = partOfDayHour(t.replace(/晚点|早点|晚些|早些/g, ''));
  if (/后天|day after tomorrow/.test(t)) return text(dayAt(now, 2, part ?? defaultHour));
  if (/明早/.test(t)) return text(dayAt(now, 1, 10));
  if (/明晚/.test(t)) return text(dayAt(now, 1, 21));
  if (/明天|tomorrow/.test(t)) return text(dayAt(now, 1, part ?? defaultHour));
  if (/今晚|tonight/.test(t)) {
    const d = dayAt(now, 0, 21);
    return text(d.getTime() > now.getTime() ? d : new Date(now.getTime() + 2 * 3600_000));
  }

  const zhDay = /(下)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(s);
  const enDay = /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (zhDay || enDay) {
    const target = zhDay ? WEEKDAY_ZH[zhDay[2]] : WEEKDAY_EN[enDay![2]];
    const nextWeek = !!(zhDay ? zhDay[1] : enDay![1]);
    let days = (target - now.getDay() + 7) % 7 || 7;
    if (nextWeek) {
      // "下周三" / "next Wednesday": the one in the coming (Monday-start) week.
      const toNextMonday = (1 - now.getDay() + 7) % 7 || 7;
      days = toNextMonday + ((target + 6) % 7);
    }
    return text(dayAt(now, days, part ?? defaultHour));
  }
  if (/下周|next week/.test(t)) {
    const days = ((1 - now.getDay() + 7) % 7) || 7;
    return text(dayAt(now, days, defaultHour));
  }
  if (/今天|today|later today|end of (?:the )?day|eod|下班前/.test(t) || (part !== null && !/明|tomorrow/.test(t))) {
    const d = dayAt(now, 0, part ?? 18);
    if (d.getTime() > now.getTime()) return text(d);
    return text(new Date(now.getTime() + 3 * 3600_000));
  }
  if (/稍后|待会|一会儿|晚点|马上|soon|shortly|in a bit|later/.test(t)) {
    return text(new Date(now.getTime() + 2 * 3600_000));
  }
  return { due: new Date(now.getTime() + OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_MS), source: 'default' };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Asks the owner to decide or confirm (Chinese): a yes/no or either/or shape.
 * Open information questions ("你们每周花多少小时？") are left alone — a card
 * cannot answer them, and the agent sees the owner's reply anyway.
 */
const ZH_ASK = /吗|要不要|是不是|是否|可不可以|能不能|行不行|好不好|同意|确认|批准|拍板|还是|对吧|对不对|OK|ok|定一下/u;

/** Asks the owner to decide or confirm (English): yes/no or either/or. */
const EN_ASK =
  /^(?:so,?\s+)?(?:should|shall|do|does|can|could|would|will|is|are|may|want|ok|okay|any objection|happy|good)\b|\bwant me to\b|\bok(?:ay)?\s*\?$|\bright\s*\?$|\bor\b[^?]*\?$/i;

/** Rhetorical openers: the agent is not asking. */
const RHETORICAL_OPEN = /^(?:难道|凭什么|谁说|岂不是|何必|你可能会问|你也许会问|有人会问|为什么(?!你)|what if\b|who says\b|isn'?t it\b|why would\b|you might ask\b|you may ask\b|why\b(?! did you| do you| would you))/iu;

/** A sentence that answers the question before it. */
const SELF_ANSWER = /^(?:因为|答案|原因是|原因在于|其实|简单说|because\b|the answer\b|that'?s because\b|simple[:：])|^[*_]*\s*(?:要|不要|是|不是|对|不对|可以|不可以|不行|会|不会|能|不能|yes|no)\s*[，,。.!！：:]/iu;

/**
 * Whether a sentence (with its neighbours) is a question for the owner.
 *
 * @param s - The sentence
 * @param next - The sentence after it on the same line, if any
 * @param opts - Extraction options
 * @returns True for a decision/confirmation question to the owner
 */
export function isOwnerQuestion(s: string, next: string | undefined, opts: ExtractOptions): boolean {
  const t = s.trim();
  if (!/[?？]\s*[)）]?$/.test(t)) return false;
  if (questionIsQuoted(t)) return false;
  if (RHETORICAL_OPEN.test(t)) return false;
  if (next && SELF_ANSWER.test(next.trim())) return false;
  if (addressedToColleague(t, opts)) return false;
  const core = t.replace(/[?？\s]+$/u, '');
  if (core.replace(/[\s*_]/g, '').length < 4) return false;
  return /[一-鿿]/.test(t) ? ZH_ASK.test(t) : EN_ASK.test(t);
}

/**
 * Questions for someone else that the agent wrote down for the owner — an
 * interview guide, a survey, what to ask a client ("问这几件事：", "访谈问题",
 * "questions to ask the client"). Matched on the question and on the line that
 * introduces it (2026-10-08: Atlas's interview questions became owner cards).
 */
const THIRD_PARTY_FRAME =
  /问(?:这|那)?(?:几|些|个|四|三|五)(?:件事|个问题|问题)|访谈|采访|问卷|调研问题|面试(?:问题|题)|(?:可以|要|去|先|就)?问(?:他|她|他们|她们|客户|对方|用户|家长|老师|学生|老板|候选人)(?:[：:]|这|那|几|一|$)|(?:他|她|客户|对方|用户)(?:要是|如果)?(?:答|回答)|interview (?:questions?|guide|script)|survey|questionnaire|\bask (?:them|him|her|the (?:client|customer|prospect|user)s?|prospects|clients|customers)\b|questions? (?:to ask|for (?:the )?(?:clients?|customers?|prospects?|users?))/iu;

/**
 * A paragraph that may follow the final question's paragraph: references,
 * links, a P.S. or a sign-off ("参考：…", "https://…", "谢谢").
 */
const TRAILING_PARAGRAPH = /^(?:参考|来源|出处|链接|附[:：]|附件|ps\b|p\.s\.|注[:：]|https?:\/\/|<https?:|谢谢|多谢|thanks|thank you|sources?\b|refs?\b|references?\b)/iu;

/** A sentence ending in a question mark (outside quotes: see {@link questionIsQuoted}). */
function endsAsQuestion(s: string): boolean {
  const t = s.trim();
  return /[?？]\s*[)）]?$/.test(t) && !questionIsQuoted(t);
}

/**
 * Whether a question is content the agent wrote for someone else: a list
 * item, or under / inside an interview / survey frame.
 *
 * @param s - The question sentence
 * @returns True when it is not asked of the owner
 */
function isListedOrForThirdParty(s: Sentence): boolean {
  if (s.listItem) return true;
  if (THIRD_PARTY_FRAME.test(s.text)) return true;
  // The line right before introduces it ("每个人都问这四个：", "Questions to ask:").
  if (s.prevLine && THIRD_PARTY_FRAME.test(s.prevLine)) return true;
  return false;
}

/**
 * The questions of a message that may be carded: only its FINAL question,
 * when it is a decision question for the owner and not listed content.
 *
 * - "Final": no question comes after it, and what follows stays in its
 *   paragraph (how to answer, what happens on a yes: "要发布吗？回「发」我就
 *   上线。") — later paragraphs may only be references, links or a sign-off.
 *   A question in the middle of a message is followed by more: the agent moved
 *   on, answered it itself or listed it.
 * - Consecutive either/or alternatives on its line stay together (one card).
 *
 * The owner can still answer any other question in the thread; it just gets
 * no card (2026-10-08 card audit: 88 of 437 auto cards were not their
 * message's last question, and a third of those were skipped or withdrawn).
 *
 * @param sentences - The message's sentences
 * @param opts - Extraction options
 * @returns Indexes into `sentences` of the questions to keep (in order)
 */
function finalQuestionIndexes(sentences: Sentence[], opts: ExtractOptions): number[] {
  let last = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (endsAsQuestion(sentences[i].text)) {
      last = i;
      break;
    }
  }
  if (last < 0) return [];
  const para = sentences[last].para;
  const laterParas = new Map<number, string>();
  for (const s of sentences.slice(last + 1)) {
    if (s.para !== para && !laterParas.has(s.para ?? 0)) laterParas.set(s.para ?? 0, s.text);
  }
  for (const first of laterParas.values()) {
    if (!TRAILING_PARAGRAPH.test(first.trim())) return [];
  }
  const isQ = (i: number): boolean => {
    const s = sentences[i];
    const next = s.line[s.index + 1];
    return isOwnerQuestion(s.text, next, opts) && !isListedOrForThirdParty(s);
  };
  if (!isQ(last)) return [];
  const out = [last];
  // Alternatives right before it on the same line ("先改？还是先试现在的版本？").
  for (let i = last - 1; i >= 0 && out.length < OPEN_ITEMS_CONSTANTS.MAX_ITEMS_PER_REPLY; i--) {
    if (sentences[i].line !== sentences[last].line || !isQ(i)) break;
    out.unshift(i);
  }
  return out;
}

/**
 * A fallback sentence: what the agent does without an answer ("不同意的话我就删掉").
 *
 * @param s - Sentence after the question
 * @returns True when it states a fallback
 */
function isFallback(s: string | undefined): boolean {
  if (!s) return false;
  return /的话|否则|不然|if not\b|otherwise\b|if you don'?t\b|if you disagree\b|unless you\b|if i don'?t hear\b|if there'?s no objection\b|if no objection\b/iu.test(s);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Find open items in an agent's reply to the owner.
 *
 * @param text - The reply
 * @param opts - Clock, colleague names, owner id
 * @returns Commitments and questions (each at most
 *   {@link OPEN_ITEMS_CONSTANTS.MAX_ITEMS_PER_REPLY})
 *
 * @example
 * extractOpenItems('明天中午给我，我核过以后挑最有用的几条发你。', { now })
 * // → { commitments: [{ text: '明天中午给我，我核过以后挑最有用的几条发你。', due: <tomorrow 12:00>, … }], questions: [] }
 */
export function extractOpenItems(text: string, opts: ExtractOptions): ExtractedOpenItems {
  const out: ExtractedOpenItems = { commitments: [], questions: [] };
  if (!text || !text.trim()) return out;
  const max = OPEN_ITEMS_CONSTANTS.MAX_ITEMS_PER_REPLY;
  const sentences = splitSentences(text);
  const finalQuestions = new Set(finalQuestionIndexes(sentences, opts));
  for (const [i, sentence] of sentences.entries()) {
    const s = sentence.text;
    const next = sentence.line[sentence.index + 1];
    if (finalQuestions.has(i)) {
      out.questions.push({
        type: 'question',
        text: clip(s, OPEN_ITEMS_CONSTANTS.QUESTION_MAX_CHARS),
        ...(isFallback(next) ? { fallback: clip(next!, OPEN_ITEMS_CONSTANTS.QUESTION_MAX_CHARS) } : {}),
      });
      continue;
    }
    // Any other question is not a promise either.
    if (/[?？]\s*[)）]?$/.test(s.trim())) continue;
    if (out.commitments.length < max && !addressedToColleague(s, opts) && isCommitment(s)) {
      const { due, source } = parseDue(s, opts.now);
      out.commitments.push({ type: 'commitment', text: clip(s, OPEN_ITEMS_CONSTANTS.TEXT_MAX_CHARS), due, dueSource: source, ...(waitsOnOwner(s) ? { waitsOnOwner: true } : {}) });
    }
  }
  return out;
}
