/**
 * Browser outbound guard — which agent browser actions publish something as
 * the owner, so they must be held for an owner approval card.
 *
 * Why (2026-10-03): an agent posted a LinkedIn reply as the owner without
 * approval. The existing check (`matchIrreversible`) only read a short word
 * list against the agent's selector, so a LinkedIn reply went through:
 * `button.comments-comment-box__submit-button` hides "submit" behind `__`
 * (a word character, so `\bsubmit\b` never matched), "Reply" and "Comment"
 * were not on the list, a click by coordinates or by element ref carried no
 * words at all, `type` with a trailing newline and `Ctrl+Enter`/`Cmd+Enter`
 * keys were not checked, and `el['click']()` in a page script was not seen
 * as acting.
 *
 * This module closes those paths, without holding what only reads:
 *
 * - Descriptors are split into words at punctuation (`__submit-button` →
 *   "submit button"), not at camelCase (code identifiers are not controls).
 * - A control whose whole label is Reply/Comment/Post/Send/Tweet (plus
 *   Share/Connect/Invite on social sites) is held; bare "comment"/"tweet"
 *   in class names (a comment item, a tweet being read) are not.
 * - Any key that submits (Enter, Return, with or without modifiers) and any
 *   typed text containing a newline or a submit flag is held.
 * - A page script is held when it acts AND sends a writing request or names
 *   a submit control — not for clicking "See more".
 * - On social and messaging sites (LinkedIn, X, Facebook, Instagram, Reddit,
 *   Gmail/Outlook web, Slack web, WhatsApp web, …) a click that names no
 *   control (coordinates, refs) is held: there the harness cannot tell a
 *   "Post" from any other button.
 *
 * @module services/browser/browser-outbound-guard
 */

import { createHash } from 'crypto';
import { BROWSER_OUTBOUND_GUARD } from '../../constants.js';

/** Where the action happens, as far as the harness knows. */
export interface OutboundContext {
	/** URL of the page (last navigation of the session), when known */
	url?: string;
}

/**
 * Host of a URL, lower case, '' when it cannot be parsed.
 *
 * @param url - URL
 * @returns Host
 */
function hostOf(url: string | undefined): string {
	if (!url) return '';
	try {
		return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Whether a URL is on a social or messaging site, where posting reaches
 * other people as the owner.
 *
 * @param url - Page URL
 * @returns True for a listed host or any of its subdomains
 */
export function isSocialOrMessagingSite(url: string | undefined): boolean {
	const host = hostOf(url);
	if (!host) return false;
	return BROWSER_OUTBOUND_GUARD.SOCIAL_MESSAGING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Split a selector/label/script into words at punctuation, so word-boundary
 * matching sees through CSS naming (`comments-comment-box__submit-button` →
 * "comments comment box submit button"). camelCase is NOT split: code
 * identifiers (`postCount`, `commentsList`) are not controls.
 *
 * @param text - Raw descriptor
 * @returns Space-separated words
 */
export function toWords(text: string): string {
	return text
		.replace(/[_\-.#[\]=:"'`()>+~*^$|/\\,;{}]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The words that describe what a click/select names: selector, text, value,
 * aria label, label, name, title.
 *
 * @param params - Tool params
 * @returns Descriptor text ('' when the action names nothing)
 */
export function descriptorOf(params: Record<string, unknown> | undefined): string {
	const fields = ['selector', 'text', 'value', 'ariaLabel', 'label', 'name', 'title'];
	return fields
		.map((f) => params?.[f])
		.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
		.join(' ');
}

/**
 * Whole labels an action names: its `text`/`ariaLabel`/`label`, and labels
 * quoted inside a selector (`:has-text("Reply")`, `[aria-label="Post"]`,
 * `text=Send`) or a script (`b.innerText === 'Reply'`).
 *
 * @param params - Tool params
 * @returns Labels, lower case, trimmed
 */
export function labelsOf(params: Record<string, unknown> | undefined): string[] {
	const labels: string[] = [];
	for (const f of ['text', 'ariaLabel', 'label', 'value']) {
		const v = params?.[f];
		if (typeof v === 'string' && v.trim()) labels.push(v);
	}
	for (const f of ['selector', 'code']) {
		const v = params?.[f];
		if (typeof v !== 'string') continue;
		// Attribute labels and text pseudo-selectors (in a selector, or a
		// selector string inside a script). Not data-testid & co: those name
		// what an element is (a tweet), not what a button says.
		for (const m of v.matchAll(/\[\s*(?:aria-label|title|value|name|alt)\s*[*^$~|]?=\s*\\?["']([^"'\\]{1,40})\\?["']\s*\]/gi)) labels.push(m[1]);
		for (const m of v.matchAll(/:(?:has-text|text|contains|text-is)\(\s*\\?["']([^"'\\]{1,40})\\?["']\s*\)/gi)) labels.push(m[1]);
		const textEq = /^text\s*=\s*(.+)$/i.exec(v.trim());
		if (f === 'selector' && textEq) labels.push(textEq[1]);
		if (f === 'code') {
			// A script finding a button by its text: `b.innerText === 'Reply'`.
			for (const m of v.matchAll(/(?:===?|includes\(|startsWith\()\s*['"`]([^'"`\n]{1,40})['"`]/g)) labels.push(m[1]);
		}
	}
	return labels.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0);
}

/**
 * Whether an action names a control whose whole label submits.
 *
 * @param params - Tool params
 * @param social - On a social/messaging site (adds Share/Connect/…)
 * @returns The label, or null
 */
function submitLabel(params: Record<string, unknown> | undefined, social: boolean): string | null {
	const set = new Set([
		...BROWSER_OUTBOUND_GUARD.SUBMIT_LABELS,
		...(social ? BROWSER_OUTBOUND_GUARD.SOCIAL_ONLY_LABELS : []),
	]);
	return labelsOf(params).find((l) => set.has(l)) ?? null;
}

/**
 * Whether a key name submits: Enter/Return in any spelling, alone or with
 * modifiers ("Enter", "NumpadEnter", "Return", "Ctrl+Enter", "Cmd+Enter",
 * "Meta+Enter", "\n").
 *
 * @param key - Key name as passed
 * @returns True for a submitting key
 */
export function isSubmitKey(key: string): boolean {
	return /enter|return/i.test(key) || /[\r\n]/.test(key);
}

/**
 * Whether typed text submits: it contains a newline, or the call asks to
 * press Enter / submit after typing.
 *
 * @param params - `type` / `fill` / `insertText` params
 * @returns True when the call submits
 */
export function typedTextSubmits(params: Record<string, unknown> | undefined): boolean {
	const text = [params?.text, params?.value].filter((v): v is string => typeof v === 'string').join('');
	if (/[\r\n]/.test(text)) return true;
	return ['submit', 'pressEnter', 'enter', 'sendEnter'].some((k) => params?.[k] === true);
}

/**
 * Whether a page script acts (rather than reads): clicks in any form,
 * submits, fires events, edits content, or sends a non-GET request.
 *
 * @param code - Script source
 * @returns True when it acts
 */
export function scriptActs(code: string): boolean {
	return BROWSER_OUTBOUND_GUARD.SCRIPT_ACTS.test(code);
}

/**
 * Match the outward-facing words against a descriptor (already split into
 * words at punctuation).
 *
 * @param words - Descriptor words
 * @returns Label, or null
 */
export function matchOutboundWords(words: string): string | null {
	for (const [pattern, label] of BROWSER_OUTBOUND_GUARD.OUTBOUND_WORDS) {
		if (pattern.test(words)) return label;
	}
	return null;
}

/**
 * Decide whether an action publishes or submits something outward, beyond
 * the base irreversible-word check. Returns a short label, or null.
 *
 * @param tool - Browser tool
 * @param params - Its params
 * @param context - Where it happens
 * @returns Label for the hold, or null
 *
 * @example
 * ```typescript
 * matchOutbound('click', { selector: 'button.comments-comment-box__submit-button' }, { url: 'https://www.linkedin.com/feed/' });
 * // 'submitting'
 * matchOutbound('click', { selector: 'article[data-testid="tweet"]' }, { url: 'https://x.com/home' });
 * // null — reading a tweet
 * ```
 */
export function matchOutbound(
	tool: string,
	params: Record<string, unknown> | undefined,
	context: OutboundContext = {},
): string | null {
	const social = isSocialOrMessagingSite(context.url);

	switch (tool) {
		case 'pressKey': {
			const key = [params?.key, ...(Array.isArray(params?.modifiers) ? params!.modifiers as unknown[] : [])]
				.filter((v) => typeof v === 'string')
				.join('+');
			return isSubmitKey(key) ? 'submitting with a keystroke' : null;
		}
		case 'type':
		case 'fill':
		case 'insertText':
			return typedTextSubmits(params) ? 'submitting typed text' : null;
		case 'executeJs':
		case 'executeScript': {
			const code = typeof params?.code === 'string' ? params.code : '';
			const operation = typeof params?.operation === 'string' ? params.operation : '';
			const acts = scriptActs(code) || /click|submit|press|dispatch/i.test(operation);
			if (!acts) return null;
			// Acting alone is not outbound ("See more", expanding a thread):
			// held when it sends a writing request, or names a submit control.
			if (BROWSER_OUTBOUND_GUARD.SCRIPT_WRITES_REQUEST.test(code)) return 'sending a request';
			const label = submitLabel(params, social);
			if (label) return `clicking "${label}"`;
			return matchOutboundWords(toWords(`${code} ${descriptorOf(params)}`));
		}
		case 'click':
		case 'selectOption': {
			const descriptor = descriptorOf(params);
			if (!descriptor) {
				// Coordinates or an element ref: on a social site there is no
				// telling a "Post" from any other button.
				return social ? 'clicking an unnamed control on a social or messaging site' : null;
			}
			const label = submitLabel(params, social);
			if (label) return `clicking "${label}"`;
			return matchOutboundWords(toWords(descriptor));
		}
		default:
			return null;
	}
}

/**
 * The text an action would put on the page (what a post would say), for the
 * approval card. Only `type`/`fill`/`insertText` carry it directly; a script
 * is shown as source. Never for a field that looks secret (password, code,
 * token): the card goes to Slack.
 *
 * @param tool - Browser tool
 * @param params - Its params
 * @returns Text, or undefined
 */
export function draftTextOf(tool: string, params: Record<string, unknown> | undefined): string | undefined {
	if (BROWSER_OUTBOUND_GUARD.SECRET_FIELD.test(toWords(descriptorOf(params))) || params?.isPassword === true) {
		return undefined;
	}
	if (tool === 'type' || tool === 'fill' || tool === 'insertText') {
		const text = [params?.text, params?.value].find((v): v is string => typeof v === 'string' && v.trim() !== '');
		return text?.trim();
	}
	if ((tool === 'executeJs' || tool === 'executeScript') && typeof params?.code === 'string') {
		return params.code.trim();
	}
	return undefined;
}

/**
 * Identity of an action for one-time approvals: an approval is spent only
 * by the action the owner approved (same tool, same target, same text).
 *
 * @param tool - Browser tool
 * @param params - Its params
 * @returns Stable fingerprint
 */
export function actionFingerprint(tool: string, params: Record<string, unknown> | undefined): string {
	const keys = ['selector', 'text', 'value', 'code', 'key', 'modifiers', 'x', 'y', 'ref', 'index', 'operation', 'ariaLabel', 'label', 'name'];
	const picked: Record<string, unknown> = {};
	for (const k of keys) if (params?.[k] !== undefined) picked[k] = params[k];
	// Hashed: held actions are persisted, and their params (typed text) must not be.
	return `${tool}:${createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 32)}`;
}
