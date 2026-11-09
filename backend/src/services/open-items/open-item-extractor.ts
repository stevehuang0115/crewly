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
 *   A plan of concrete next steps with no deliverable named counts too
 *   ("让它们跑完，对比后看差多少", "then I'll do step 2"; crewly#1386);
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
  /** Due time of a commitment that names none (ms after `now`); default {@link OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_MS} */
  defaultDueMs?: number;
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
  /** The paragraph is introduced as a script / draft / transcript the agent is delivering ("口播脚本：", "Script:") */
  scriptFrame?: boolean;
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

/**
 * A line that introduces words the agent is DELIVERING, not saying to the
 * owner: a video / voice script, a teleprompter text, a transcript, a draft
 * ("口播脚本：", "台词", "逐字稿", "Script:"). Rhetorical lines inside it
 * ("…对吧？") are not owner questions (#1243).
 */
const SCRIPT_FRAME = /脚本|台词|口播|逐字稿|讲稿|旁白|提词|字幕|\bscript\b|teleprompter|transcript|voice-?over|narration/iu;

/**
 * First-person narration with a tag question ("所以我当时觉得，我这个设计很好，对吧？"):
 * a line of someone's story or a script, not a decision the agent needs.
 */
const NARRATIVE_VOICE = /^(?:所以|然后|那么|但是|可是|其实|就是)?[，,\s]*(?:我|我们)(?:当时|那时|那会儿|以前|曾经|后来|一开始)/u;

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
  // An intro naming a script / draft frames the paragraph it opens (not later ones).
  let scriptFrame = false;
  for (const raw of noCode.split(/\n/)) {
    const listItem = LIST_MARKER.test(raw);
    const line = raw.replace(LIST_MARKER, '').trim();
    if (!line) {
      para += 1;
      scriptFrame = false;
      continue;
    }
    if (isNonProseLine(line)) {
      // A heading or quote still introduces what follows ("*问这几件事*").
      prevLine = line;
      scriptFrame = SCRIPT_FRAME.test(line);
      continue;
    }
    if (/[:：]\s*$/.test(line) && SCRIPT_FRAME.test(line)) scriptFrame = true;
    const parts = splitLine(line);
    const before = prevLine;
    parts.forEach((p, i) => out.push({ text: p, index: i, line: parts, para, ...(scriptFrame ? { scriptFrame } : {}), ...(listItem ? { listItem } : {}), ...(before ? { prevLine: before } : {}) }));
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

/**
 * The deliverable waits on something the owner sends first ("你用手机录好直接发给我，
 * 剪好我再发回给你"): no clock runs until it arrives (2026-10-13, Milo).
 */
const OWNER_SUPPLIES =
  /(?:你|您)[^，,。；;！!]{0,24}(?:发给我|发我|传给我|传我|给我发|发过来|传过来|拍给我|录给我)|(?:once|after|when) you (?:send|share|upload|record|forward)/iu;

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
  return OWNER_GATE.test(s) || OWNER_SUPPLIES.test(s);
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
// Next steps without a deliverable (crewly#1386)
// ---------------------------------------------------------------------------

/** A step number ("第 2 步", "第二步"). */
const ZH_STEP_NO = '第\\s*[\\d一二三四五六七八九十]+\\s*步';

/** Concrete next-step actions (Chinese). */
const ZH_STEP_ACTION = `对比|比较|比一下|检查|核对|跑|开始|继续|处理|生成|提交|复刻|还原|修|测试|验证|整理|汇总|剪|拼|渲染|出图|出片|挑|合成|上传|部署|进入|推进|做|改|${ZH_STEP_NO}`;

/** "X 完 / 之后 / 然后 …": one step after another (a bare 再 is not enough: "我再看看" is not a plan). */
const ZH_SEQUENCE = `然后|接着|之后|以后|[完好](?:后|了|以后|之后)|完(?=我|再|就|[，,；;…]|$)|结束后|下一步|接下来|${ZH_STEP_NO}`;

/** First person doing a step ("我对比", "我们再跑第 2 步", "我把三条对比一下"); "给我们的结果" is not. */
const ZH_SELF_ACTS = new RegExp(`(?:我们|咱们|我)(?:会|就|先|再|然后|接着|来|去|马上|立刻|继续|开始|要|打算|准备|一起|把[^，,。；;]{0,12})*\\s*(?:${ZH_STEP_ACTION})`, 'u');

/** A plan written without a subject: it opens on the sequence ("让它们跑完…", "这批之后…", "接下来…"). */
const ZH_PLAN_OPEN = /^(?:先|等|让|这批|这轮|这几条|这几个|接下来|下一步|然后|接着|跑完|做完|生成完|渲染完)/u;

/** A sequence followed by a concrete action in the same sentence ("跑完…对比", "之后到第 2 步"). */
const ZH_SEQUENCE_THEN_ACTION = new RegExp(`(?:${ZH_SEQUENCE})[^。！？!?]{0,24}?(?:${ZH_STEP_ACTION})`, 'u');

/** A clause about what already happened ("三条已经提交", "刚才跑完了"). */
const ZH_PAST_CLAUSE = /已经|已(?:提交|发|跑|做|改|生成|渲染|完成)|刚才|刚刚|之前|上次|昨天|发现|当时|了\s*$/u;

/** Opinions, advice and hedges: not a commitment ("我觉得之后可以再试", "建议先对比"). */
const ZH_OPINION = /觉得|认为|建议|可以考虑|也许|或许|可能|不确定|看情况|说不定/u;

/** First-person future (English) — the subject of a next step. */
const EN_SELF_FUTURE = "\\b(?:i'?ll|i will|i'm going to|i am going to|we'?ll|we will|i'?m gonna)\\b";

/** Concrete next-step actions (English). */
const EN_STEP_ACTION =
  '\\b(?:do|start|run|re-?run|compare|check|review|move on|continue|replicate|render|generate|build|fix|test|look at|work on|tackle|handle|pick up|redo|process|merge|kick off|begin|proceed|go on|step \\d+)\\b';

/** A first-person future step ("then I'll do step 2", "I'll compare them next"). */
const EN_SELF_STEP = new RegExp(`${EN_SELF_FUTURE}[^.?!]{0,60}?${EN_STEP_ACTION}`, 'i');

/** Sequencing (English): then / next / after that / once they finish / step N. */
const EN_SEQUENCE =
  /\b(?:then|next|afterwards|after (?:that|this|these|those|it|they|which)|(?:once|when) (?:it|they|that|this|these|those|the \w+(?: \w+)?) (?:finish|finishes|are done|is done|complete|completes|land|lands)|step \d+)\b/i;

/** Hedges, opinions and lessons (English): not a commitment. */
const EN_NEXT_SKIP = /\b(?:maybe|might|probably|perhaps|could|i think|not sure|next time|we'?ll see|you)\b/i;

/**
 * Whether a sentence commits to concrete next steps with no deliverable named
 * ("让它们跑完，对比后看差多少", "这批之后到第 2 步结束", "then I'll do step 2").
 * {@link isCommitment} needs a deliverable for the owner ("发你", "send you"),
 * so a plan of next steps was never tracked and nobody came back to it when
 * the owner moved on (crewly#1386, Pia 2026-10-18).
 *
 * Conservative on purpose — it needs all of:
 * - the agent as the one acting: a first-person subject doing a step
 *   ("我对比", "I'll run"), or (Chinese only) a sentence that opens on the
 *   sequence itself ("让它们跑完…", "这批之后…", "接下来…");
 * - a sequence: one step after another (然后 / 之后 / X 完后 / 第 N 步,
 *   then / next / after that / once they finish / step N);
 * - a concrete action (对比, 跑, 复刻, compare, run, do step 2 …);
 * - no question, condition, habit, caveat, opinion or hedge, nothing addressed
 *   to the owner as the actor (你 / you), and (Chinese) the step itself not in
 *   the past ("三条已经提交，" is dropped, the rest is judged).
 *
 * @param s - Sentence
 * @returns True for a first-person future plan of concrete next steps
 *
 * @example
 * isNextStepCommitment('三条已经提交，让它们跑完，对比后看差多少。'); // true
 * isNextStepCommitment('我再看看。'); // false — no sequence, no concrete step
 */
export function isNextStepCommitment(s: string): boolean {
  const t = s.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|（[^）]*）|\([^)]*\)/g, ' ').trim();
  if (!t || /[?？]\s*$/.test(t)) return false;
  if (HABITUAL.test(t) || ASKS_OWNER.test(t) || CAVEAT.test(t) || HEDGE.test(t)) return false;
  if (/[一-鿿]/.test(t)) {
    if (/你|您/u.test(t) || ZH_CONDITIONAL.test(t) || ZH_OPINION.test(t)) return false;
    // Drop the clauses that report what already happened; the rest must be the plan.
    const rest = t
      .split(/[，,；;：:]/)
      .map((c) => c.trim())
      .filter((c) => c && !ZH_PAST_CLAUSE.test(c.replace(/[。！!…\s]+$/u, '')))
      .join('，');
    if (!rest || ZH_THIRD_PARTY.test(rest)) return false;
    if (!new RegExp(ZH_SEQUENCE, 'u').test(rest)) return false;
    if (ZH_SELF_ACTS.test(rest)) return true;
    return ZH_PLAN_OPEN.test(rest) && ZH_SEQUENCE_THEN_ACTION.test(rest);
  }
  if (EN_SKIP.test(t) || EN_NEXT_SKIP.test(t)) return false;
  return EN_SELF_STEP.test(t) && EN_SEQUENCE.test(t);
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

/** Chinese numerals a duration is written with ("两小时", "三十分钟"). */
const ZH_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * The number a numeral token names: ASCII digits ("1.5"), Chinese numerals up
 * to 99 ("两", "十五", "二十", "三十五"), "半" (0.5), or an approximate pair of
 * consecutive numerals ("一两", "两三", "三四" → the upper one).
 *
 * @param token - Numeral token
 * @returns The number, or null when it is not one
 */
export function numeralValue(token: string): number | null {
  const n = token.trim();
  if (!n) return null;
  if (/^\d+(?:\.\d+)?$/.test(n)) return Number(n);
  if (n === '半') return 0.5;
  if (n.includes('十')) {
    const [tens, ones = ''] = n.split('十');
    const t = tens === '' ? 1 : ZH_DIGITS[tens];
    const o = ones === '' ? 0 : ZH_DIGITS[ones];
    return t === undefined || o === undefined || n.split('十').length > 2 ? null : t * 10 + o;
  }
  const chars = [...n];
  if (chars.length === 1) return ZH_DIGITS[chars[0]] ?? null;
  if (chars.length === 2) {
    const [a, b] = chars.map((c) => ZH_DIGITS[c]);
    // "一两个小时", "两三天": a range said as two numerals — the upper bound.
    if (a !== undefined && b !== undefined && b === a + 1) return b;
  }
  return null;
}

/** A numeral token: digits, Chinese numerals, or 半. */
const NUMERAL = '(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十]{1,3}|半)';
/** A duration unit. */
const UNIT = '(小时|hours?|hrs?|分钟|minutes?|mins?|天|days?)';
/**
 * A relative duration, possibly a range ("1.5 到 2 小时", "40–60 分钟",
 * "一两个小时", "2 to 3 hours"), optionally "N 个半小时" (N.5 hours).
 */
const DURATION = new RegExp(`(${NUMERAL})(?:\\s*(?:到|至|[–—~-]|\\s+to\\s+)\\s*(${NUMERAL}))?\\s*(?:个\\s*(半)?)?\\s*${UNIT}`, 'iu');

/**
 * Milliseconds of a duration named in the text: "2 小时", "两小时", "三十分钟",
 * "一个半小时", "半天", "一天", "1.5 到 2 小时" (a range → its upper bound),
 * "an hour", "a couple of hours", "half a day". "左右", "大约", "约", "大概"
 * do not change the number.
 *
 * @param s - Sentence (any case)
 * @returns Milliseconds, or null when no duration is named
 *
 * @example
 * durationMs('预计一小时左右') // → 3600000
 * durationMs('40 到 60 分钟')  // → 3600000
 */
export function durationMs(s: string): number | null {
  const t = s.toLowerCase();
  const m = DURATION.exec(t);
  if (m) {
    const lower = numeralValue(m[1]);
    const upper = m[2] ? numeralValue(m[2]) : null;
    let n = upper ?? lower;
    if (n === null) return null;
    if (m[3]) n += 0.5;
    const unit = m[4];
    const per = /小时|hour|hr/.test(unit) ? 3600_000 : /天|day/.test(unit) ? 24 * 3600_000 : 60_000;
    const ms = n * per;
    return ms > 0 ? ms : null;
  }
  if (/半小时|half an hour/.test(t)) return 1800_000;
  if (/半天|half a day/.test(t)) return 12 * 3600_000;
  if (/\ba couple of hours\b/.test(t)) return 2 * 3600_000;
  if (/\ban? (?:hour|hr)\b/.test(t)) return 3600_000;
  if (/\ba day\b/.test(t)) return 24 * 3600_000;
  return null;
}

/**
 * When a commitment is due.
 *
 * Rules (local time): an explicit date (10/7, 10月7日, 2026-10-07) wins over everything; an explicit day/part of day wins ("明天中午" → tomorrow
 * 12:00, "tonight" → today 21:00, "by Friday" → Friday 12:00); "tomorrow"
 * alone → tomorrow {@link OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_HOUR_LOCAL}:00;
 * "in 2 hours" / "两小时" / "一两个小时" / "40 到 60 分钟" → + that long (the
 * upper bound of a range, see {@link durationMs}); nothing → +`defaultMs`
 * ({@link OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_MS} unless the caller says otherwise).
 *
 * @param s - Sentence
 * @param now - When it was said
 * @param defaultMs - Due this long after `now` when the text names no time
 * @returns Due time and whether the text named it
 */
export function parseDue(s: string, now: Date, defaultMs: number = OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_MS): { due: Date; source: 'text' | 'default' } {
  const t = s.toLowerCase();
  const defaultHour = OPEN_ITEMS_CONSTANTS.DEFAULT_DUE_HOUR_LOCAL;
  const text = (due: Date): { due: Date; source: 'text' } => ({ due, source: 'text' });

  // An explicit date wins over every relative cue and over now + default.
  const dated = explicitDate(s, now);
  if (dated) return text(dated);

  const rel = durationMs(s);
  if (rel !== null) return text(new Date(now.getTime() + rel));

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
  return { due: new Date(now.getTime() + defaultMs), source: 'default' };
}

/** Words that frame a time as an estimate ("预计明天中午能好", "应该今晚能好", "should be done by tonight", "ETA tonight"). */
const ESTIMATE_CUE = /预计|预估|估计|大约|大概|左右|应该|\beta\b|estimat|about|around|roughly|approx|should\b|within/iu;

/**
 * The due time an estimate sentence states, for a commitment sentence that
 * names none: a duration ("预计一小时左右", "大约 2 小时", "ETA 30 min") or a
 * time framed as an estimate ({@link ESTIMATE_CUE}: "预计明天中午能好"), in a
 * sentence that is not itself a commitment or a question — "预计一小时左右。"
 * after "改完发你。" dates the promise; "明天中午给你另一份。" is its own
 * promise and leaves it alone.
 *
 * @param s - The neighbouring sentence (undefined when there is none)
 * @param now - When it was said
 * @returns The due time, or null
 */
export function estimateDue(s: string | undefined, now: Date): Date | null {
  if (!s || isCommitment(s) || /[?？]\s*[)）]?$/.test(s.trim())) return null;
  if (durationMs(s) === null && !ESTIMATE_CUE.test(s)) return null;
  const parsed = parseDue(s, now);
  return parsed.source === 'text' ? parsed.due : null;
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
  if (s.scriptFrame || (NARRATIVE_VOICE.test(s.text) && /对吧|对不对|是吧|不是吗/u.test(s.text))) return true;
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
    // A plan of next steps counts too (crewly#1386), but not as list content or inside a script:
    // an echoed list of the owner's steps is not the agent promising them.
    const nextStep = (): boolean => !sentence.listItem && !sentence.scriptFrame && isNextStepCommitment(s);
    if (out.commitments.length < max && !addressedToColleague(s, opts) && (isCommitment(s) || nextStep())) {
      let { due, source } = parseDue(s, opts.now, opts.defaultDueMs);
      // The estimate often sits in the sentence after (or before) the promise:
      // "改完后我起全新评审 Agent 跑 2 轮，再发你。预计一小时左右。" (crewly#1360).
      if (source === 'default') {
        const estimated = estimateDue(next, opts.now) ?? estimateDue(sentence.line[sentence.index - 1], opts.now);
        if (estimated) [due, source] = [estimated, 'text'];
      }
      out.commitments.push({ type: 'commitment', text: clip(s, OPEN_ITEMS_CONSTANTS.TEXT_MAX_CHARS), due, dueSource: source, ...(waitsOnOwner(s) ? { waitsOnOwner: true } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Owner decisions asked in prose (crewly#1369 gap 2)
// ---------------------------------------------------------------------------

/** A yes/no decision asked of the owner in prose. */
export interface ExtractedOwnerQuestion {
  type: 'owner_question';
  /** The question sentence (clipped, one line) */
  text: string;
  /** When an answer is expected ({@link OPEN_ITEMS_CONSTANTS.OWNER_QUESTION_DUE_MS} after it was asked) */
  due: Date;
}

/** English yes/no ask shapes: the agent asks leave to act. */
const EN_DECISION_ASK =
  /^(?:so,?\s+|and\s+|ok,?\s+|okay,?\s+)?(?:should|shall|can|may) (?:i|we)\b|\b(?:do you want|would you like|want) me to\b|\bshould (?:i|we)\b|\bshall (?:i|we)\b|\b(?:ok|okay|fine|alright) (?:if|to|for me to)\b|\bare you (?:ok|okay|fine|happy) (?:with|if)\b|\bany objections? to\b|\bdo (?:you|we) (?:still )?want (?:to|me to)\b/i;

/** English verbs of a decision about the work. */
const EN_DECISION_VERB =
  /\b(?:merge|close|delete|remove|drop|publish|post|send|deploy|ship|release|cancel|archive|revert|roll ?back|approve|keep|continue|proceed|go ahead|launch|push|reply|pay|buy|sign|book|discard|abandon|reopen|restart|stop|pause|merging|closing|deleting|removing|publishing|posting|sending|deploying|shipping|releasing|cancell?ing|reverting|approving|keeping|continuing|proceeding|launching|pushing|replying)\b/i;

/** Chinese yes/no ask shapes. */
const ZH_DECISION_ASK = /要不要|需不需要|是否|可不可以|能不能|行不行|好不好|可以吗|行吗|好吗|吗\s*[?？]\s*[)）]?$/u;

/** Chinese verbs of a decision about the work. */
const ZH_DECISION_VERB = /合并|合进|关闭|关掉|删除|删掉|发布|上线|发出去|发送|发给|部署|取消|保留|继续|回滚|归档|推送|回复|付款|购买|签约|预订|放弃|停掉|暂停|重启/u;

/** Open information questions: a card or a yes cannot answer them. */
const INFO_QUESTION = /怎么|如何|为什么|为何|什么|哪|几|多少|多久|谁|^(?:how|what|why|where|when|which|who|whose)\b/iu;

/**
 * Whether a sentence asks the owner a yes/no decision about the work
 * ("Should I close PR #1138?", "要不要合并？"). Conservative on purpose: a
 * question mark, a yes/no ask shape AND a decision verb, not quoted, not
 * rhetorical, not answered by the next sentence, not for a colleague.
 *
 * @param s - Sentence
 * @param next - The sentence after it on the same line, if any
 * @param opts - Extraction options
 * @returns True for an owner decision
 */
export function isOwnerDecisionQuestion(s: string, next: string | undefined, opts: ExtractOptions): boolean {
  const t = s.trim();
  if (!/[?？]\s*[)）]?$/.test(t) || questionIsQuoted(t)) return false;
  if (RHETORICAL_OPEN.test(t) || INFO_QUESTION.test(t)) return false;
  if (next && SELF_ANSWER.test(next.trim())) return false;
  if (addressedToColleague(t, opts)) return false;
  if (t.replace(/[?？\s*_]/g, '').length < 6) return false;
  if (/[一-鿿]/.test(t)) return ZH_DECISION_ASK.test(t) && ZH_DECISION_VERB.test(t) && !/已经|了吗|过吗|没有吗/u.test(t);
  return EN_DECISION_ASK.test(t) && EN_DECISION_VERB.test(t);
}

/**
 * Every yes/no decision an agent asked the owner in a message, anywhere in
 * it (not only the final question {@link extractOpenItems} cards). Each goes
 * on file with a due time so the answer — or the silence — is recorded and
 * followed up (crewly#1369: "Ella asked Steve whether to close PR #1138" left
 * no record, and nobody knew what he answered).
 *
 * @param text - The agent's message
 * @param opts - Clock, colleague names, owner id
 * @returns At most {@link OPEN_ITEMS_CONSTANTS.MAX_ITEMS_PER_REPLY} questions, in order
 *
 * @example
 * extractOwnerDecisionQuestions('PR #1138 is still open. Should I close it? Tests pass.', { now })
 * // → [{ type: 'owner_question', text: 'Should I close it?', due: <now + 24 h> }]
 */
export function extractOwnerDecisionQuestions(text: string, opts: ExtractOptions): ExtractedOwnerQuestion[] {
  if (!text || !text.trim()) return [];
  const out: ExtractedOwnerQuestion[] = [];
  const due = new Date(opts.now.getTime() + OPEN_ITEMS_CONSTANTS.OWNER_QUESTION_DUE_MS);
  for (const s of splitSentences(text)) {
    if (out.length >= OPEN_ITEMS_CONSTANTS.MAX_ITEMS_PER_REPLY) break;
    if (isListedOrForThirdParty(s)) continue;
    if (!isOwnerDecisionQuestion(s.text, s.line[s.index + 1], opts)) continue;
    const q = clip(s.text, OPEN_ITEMS_CONSTANTS.QUESTION_MAX_CHARS);
    if (!out.some((o) => o.text === q)) out.push({ type: 'owner_question', text: q, due });
  }
  return out;
}
