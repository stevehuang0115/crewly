/**
 * Stated intent and deliverable extraction (text heuristics, no LLM).
 *
 * `detectStatedIntent` recognises an agent telling the owner it is starting
 * work NOW ("I'm breaking down the shot list now", "next step is X", 「我现在…」,
 * 「做好发你」). It is narrower than the owner-thread sentinel's promise
 * detector on purpose: a promise is any "I'll report back"; a stated intent is
 * "I am doing this right now", which a turn that ends right after it has
 * broken. See specs/2026-10-10-agent-follow-through.md.
 *
 * `extractDeliverables` reads an owner's request for the separate things it
 * asks for (numbered items, 「三个视频」, "one … another …") so partial
 * delivery can be shown ("1 of 3 delivered").
 *
 * @module services/agent/stated-intent
 */

/** What an agent said it is starting. */
export interface StatedIntent {
  /** The sentence that says it (clipped) */
  sentence: string;
}

const EN_NOW = [
  // "I'm starting / breaking down / building … (now)"
  /\b(?:i'?m|i am|we'?re|we are)\s+(?:now\s+|just\s+|about to\s+|going to\s+)?(?:starting|beginning|kicking off|breaking down|building|rebuilding|writing|making|creating|drafting|recording|rendering|editing|fixing|implementing|working on|doing|running|generating|replicating|redoing|putting together)\b/i,
  // "next step is …", "the next step will be …"
  /\b(?:the\s+)?next step(?:\s+(?:is|will be)|:)/i,
  // "I'll start/build … now|right away|next|immediately"
  /\b(?:i'?ll|i will|let me)\s+(?:now\s+)?(?:start|begin|build|make|create|write|do|draft|record|render|rebuild|fix|get (?:started|going)|work on|break down)\b[^.!?\n]*\b(?:now|right away|immediately|next|first|straight away)\b/i,
  /\b(?:starting|beginning)\s+(?:now|right now|on (?:it|that|this))\b/i,
  /\bnow\s+(?:building|writing|making|creating|drafting|recording|rendering|breaking|starting|working)\b/i,
];
const ZH_NOW = /(我现在(?:就)?(?:开始|去|来|做|写|改|弄|拆|搭|录|剪|做)|我这就|现在就(?:开始|去|做|来)|马上(?:开始|去|做|来)|接下来(?:我)?(?:会|要|就)?[^，。\n]{0,12}|下一步(?:是|就是|我)|(?:做好|做完|弄好|写好|剪好|搞好)(?:后|了)?(?:就)?(?:发|给|交)你|开始(?:做|拆|写|搭|剪|录))/;

/** The agent is waiting on somebody else: not "doing it now". */
const WAITING = /\b(?:wait(?:ing)? (?:for|on)|once you|after you|when you (?:confirm|reply|answer|tell)|until you|if you (?:confirm|want|prefer|like|say)|let me know (?:if|which|whether))\b|(?:等你|等您|你确认|你回复|你告诉我|待你|您确认)/i;

/** A report of finished work, however it starts. */
const DONE_REPORT = /^\s*(?:done\b|finished\b|all done|已(?:经)?(?:完成|发|做好|搞定)|完成了|做好了|搞定了)/i;

/**
 * Whether an agent post says it is starting work now.
 *
 * Returns null for finished-work reports, for text that waits on someone
 * else, and for a post that ends in a question (the agent is asking, not
 * starting).
 *
 * @param text - The agent's post to the owner
 * @returns The stated intent, or null
 *
 * @example
 * ```typescript
 * detectStatedIntent("I'm breaking down the reference shot list now, then building the crab version.");
 * // { sentence: "I'm breaking down the reference shot list now, …" }
 * detectStatedIntent('Done — the video is attached.'); // null
 * ```
 */
export function detectStatedIntent(text: string): StatedIntent | null {
	const t = (text ?? '').trim();
	if (t.length < 4) return null;
	if (DONE_REPORT.test(t)) return null;
	if (/[?？]\s*$/.test(t)) return null;
	const sentences = t.split(/(?<=[.!。！？\n])\s*/).map((s) => s.trim()).filter(Boolean);
	for (const s of sentences) {
		if (WAITING.test(s)) continue;
		if (EN_NOW.some((re) => re.test(s)) || ZH_NOW.test(s)) {
			// A sentence that is itself a past-tense report ("I've started …") never matches the patterns above.
			return { sentence: s.length > 200 ? `${s.slice(0, 199)}…` : s };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

/** Most checklist items kept for one request. */
export const MAX_DELIVERABLES = 8;

const NUM_WORDS: Record<string, number> = {
	两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, two: 2, three: 3, four: 4, five: 5, six: 6,
};
const NOUN = '(?:videos?|clips?|posts?|articles?|reports?|images?|designs?|pages?|slides?|decks?|drafts?|versions?|docs?|documents?|mockups?|banners?|logos?|视频|文章|海报|报告|页面|版本|文档|方案|稿|帖子?|图片?|封面|配图)';
const COUNTED = new RegExp(`(?:^|[^\\d\\w])(\\d|两|二|三|四|五|六|two|three|four|five|six)\\s*(?:个|条|支|份|篇|张|套|组|版)?\\s*(${NOUN})`, 'i');

/**
 * @param s - Item text
 * @returns Whitespace-collapsed, clipped text
 */
function clipItem(s: string): string {
	const one = s.replace(/\s+/g, ' ').trim().replace(/^[\s,;；，。.\-–—:：]+|[\s,;；，。]+$/g, '');
	return one.length > 140 ? `${one.slice(0, 139)}…` : one;
}

/**
 * The separate things an owner's request asks for.
 *
 * Order of trust: explicit numbered/bulleted lists, inline "(1) … (2) …" /
 * 「第一…第二…」 / "first … second …", "one … another …" / 「一个…另一个…」, then a
 * bare count ("three videos" → three items). Returns [] when the request asks
 * for one thing (or the shape is unclear): a checklist is only worth showing
 * when partial delivery is possible.
 *
 * @param text - The owner's words
 * @returns 2..{@link MAX_DELIVERABLES} items, or []
 */
export function extractDeliverables(text: string): string[] {
	const t = (text ?? '').trim();
	if (!t) return [];

	// 1. Lines that start with 1. / 1) / 1、 / ① / - / •
	const lines = t.split(/\n/).map((l) => l.trim());
	const listed = lines
		.map((l) => /^(?:\(?[1-9]\d?[.)）、:：]|[①②③④⑤⑥⑦⑧⑨]|[-*•])\s*(.+)$/.exec(l)?.[1])
		.filter((x): x is string => !!x && x.trim().length > 1);
	if (listed.length >= 2) return listed.slice(0, MAX_DELIVERABLES).map(clipItem);

	// 2. Inline numbering: "(1) a (2) b", "1) a 2) b", 「第一…第二…」, "first … second …"
	const numbered = /(?:\(|（)?\b1[.)）、]|第一|\bfirst\b/i.test(t) && /(?:\(|（)?\b2[.)）、]|第二|\bsecond\b/i.test(t);
	if (numbered) {
		// Everything before the first marker is the preamble, not an item.
		const items = t
			.split(/(?:\(|（)?\b[1-9][.)）、]\s*|第[一二三四五六七八九]\s*[个条、,，:：]?|\b(?:first|second|third|fourth)\b[,:]?\s*/i)
			.slice(1)
			.map(clipItem)
			.filter((s) => s.length > 1);
		if (items.length >= 2) return items.slice(0, MAX_DELIVERABLES);
	}

	// 3. "one … another …" / 「一个…另一个…」
	if (/\bone\b|一个/i.test(t) && /\banother\b|the other|a second|另一个|还有一个|再一个|另外一个/i.test(t)) {
		const items = t
			.split(/\b(?:one|another|the other|a second|a third)\b|另一个|还有一个|再一个|另外一个|一个/i)
			.slice(1)
			.map(clipItem)
			.filter((s) => s.length > 1);
		if (items.length >= 2) return items.slice(0, MAX_DELIVERABLES);
	}

	// 4. A bare count: "three videos"
	const m = COUNTED.exec(t);
	if (m) {
		const raw = (m[1] ?? '').toLowerCase();
		const n = /^\d$/.test(raw) ? Number(raw) : NUM_WORDS[raw] ?? 0;
		const noun = (m[2] ?? '').toLowerCase();
		if (n >= 2 && n <= MAX_DELIVERABLES) return Array.from({ length: n }, (_, i) => `${noun} ${i + 1} of ${n}`);
	}
	return [];
}
