/**
 * Owner Browser Input
 *
 * Turns what the owner does to a picture of a page — tap here, type this,
 * press Enter — into the browser operations an agent would use, aimed at the
 * tab of the session the owner has taken over.
 *
 * The owner is usually not at the machine. They are on a phone, looking at a
 * frame the live view captured, and "Take control" used to lock the agent
 * out and then leave them with nothing they could do. This module is the
 * pure half of fixing that: validating input, mapping a tap on the frame to a
 * point on the page, and choosing the operation. Dispatch lives in the browser
 * controller, which already owns transport selection.
 *
 * **Typed text is a password more often than not.** Nothing here logs it,
 * describes it or keeps it; {@link describeOwnerInput} reports only how many
 * characters were typed.
 *
 * @module services/browser/owner-browser-input
 */

import { BROWSER_OWNER_INPUT_CONSTANTS } from '../../constants.js';

/** A key the owner can press from the control bar. */
export type OwnerKey = (typeof BROWSER_OWNER_INPUT_CONSTANTS.KEYS)[number];

/** One thing the owner did. */
export type OwnerInput =
	| {
			kind: 'tap';
			/** X in the displayed frame's own pixels */
			x: number;
			/** Y in the displayed frame's own pixels */
			y: number;
			/** Natural width of the frame the owner tapped */
			frameWidth: number;
			/** Natural height of the frame the owner tapped */
			frameHeight: number;
	  }
	| { kind: 'type'; text: string }
	| { kind: 'key'; key: OwnerKey }
	| { kind: 'scroll'; dy: number }
	| { kind: 'navigate'; url: string }
	| { kind: 'back' };

/** A page's visible area in CSS pixels. */
export interface Viewport {
	width: number;
	height: number;
}

/** One browser operation, as the extension names it. */
export interface OwnerCommand {
	tool: string;
	params: Record<string, unknown>;
}

/** Result of {@link parseOwnerInput}. */
export type ParsedOwnerInput = { ok: true; input: OwnerInput } | { ok: false; error: string };

/**
 * Whether a value is a finite number.
 *
 * @param v - Anything
 * @returns True for a finite number
 */
function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Whether a string is one of the keys the control bar offers.
 *
 * @param key - Candidate key name
 * @returns True when allowed
 */
export function isOwnerKey(key: unknown): key is OwnerKey {
	return typeof key === 'string' && (BROWSER_OWNER_INPUT_CONSTANTS.KEYS as readonly string[]).includes(key);
}

/**
 * Normalise a URL the owner typed into the address field.
 *
 * A bare host (`login.gov`) gets `https://`. Anything that is not http(s)
 * after that — `javascript:`, `file:`, `chrome:` — is refused: the address
 * field opens pages, it does not run code or read the disk.
 *
 * @param raw - What the owner typed
 * @returns The URL to open, or null when it is not an http(s) URL
 */
export function normalizeOwnerUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > BROWSER_OWNER_INPUT_CONSTANTS.MAX_URL_LENGTH) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * Validate a request body into an {@link OwnerInput}.
 *
 * Error messages never quote the body: for `type` it is a password.
 *
 * @param body - Parsed JSON body
 * @returns The input, or a reason it was refused
 *
 * @example
 * ```typescript
 * parseOwnerInput({ kind: 'key', key: 'Enter' }); // { ok: true, input: { kind: 'key', key: 'Enter' } }
 * parseOwnerInput({ kind: 'key', key: 'F5' });    // { ok: false, error: '...' }
 * ```
 */
export function parseOwnerInput(body: unknown): ParsedOwnerInput {
	const b = (body ?? {}) as Record<string, unknown>;
	switch (b.kind) {
		case 'tap': {
			const { x, y, frameWidth, frameHeight } = b;
			if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(frameWidth) || !isFiniteNumber(frameHeight)) {
				return { ok: false, error: 'tap needs numeric x, y, frameWidth and frameHeight' };
			}
			if (frameWidth <= 0 || frameHeight <= 0) {
				return { ok: false, error: 'frameWidth and frameHeight must be positive' };
			}
			if (x < 0 || y < 0 || x > frameWidth || y > frameHeight) {
				return { ok: false, error: 'tap is outside the frame' };
			}
			return { ok: true, input: { kind: 'tap', x, y, frameWidth, frameHeight } };
		}
		case 'type': {
			if (typeof b.text !== 'string' || b.text.length === 0) {
				return { ok: false, error: 'type needs non-empty text' };
			}
			if (b.text.length > BROWSER_OWNER_INPUT_CONSTANTS.MAX_TEXT_LENGTH) {
				return { ok: false, error: `text is longer than ${BROWSER_OWNER_INPUT_CONSTANTS.MAX_TEXT_LENGTH} characters` };
			}
			return { ok: true, input: { kind: 'type', text: b.text } };
		}
		case 'key': {
			if (!isOwnerKey(b.key)) {
				return { ok: false, error: `key must be one of ${BROWSER_OWNER_INPUT_CONSTANTS.KEYS.join(', ')}` };
			}
			return { ok: true, input: { kind: 'key', key: b.key } };
		}
		case 'scroll': {
			if (!isFiniteNumber(b.dy) || b.dy === 0) return { ok: false, error: 'scroll needs a non-zero numeric dy' };
			const max = BROWSER_OWNER_INPUT_CONSTANTS.MAX_SCROLL_PX;
			return { ok: true, input: { kind: 'scroll', dy: Math.max(-max, Math.min(max, Math.round(b.dy))) } };
		}
		case 'navigate': {
			const url = typeof b.url === 'string' ? normalizeOwnerUrl(b.url) : null;
			if (!url) return { ok: false, error: 'navigate needs an http(s) URL' };
			return { ok: true, input: { kind: 'navigate', url } };
		}
		case 'back':
			return { ok: true, input: { kind: 'back' } };
		default:
			return { ok: false, error: 'kind must be one of tap, type, key, scroll, navigate, back' };
	}
}

/**
 * Map a tap on the displayed frame to a point on the page.
 *
 * The frame is a downscaled capture of the visible viewport — at half scale
 * on a 2× display its pixels happen to equal CSS pixels, at 1× they are half
 * of them, and when the extension could not apply the scale they are device
 * pixels. Rather than guess which, the tap is taken as a fraction of the
 * frame and applied to the viewport's measured CSS size, which is the space
 * CDP mouse events use. The frame covers exactly the visual viewport (the
 * extension clips to it), so the fractions line up.
 *
 * @param tap - Where the owner tapped, in frame pixels, and the frame's size
 * @param viewport - The page's visible area in CSS pixels
 * @returns The point to click, in CSS pixels, clamped inside the viewport
 *
 * @example
 * ```typescript
 * // 1× display, half-scale frame: 640×400 frame over a 1280×800 viewport
 * mapTapToViewport({ x: 320, y: 100, frameWidth: 640, frameHeight: 400 }, { width: 1280, height: 800 });
 * // → { x: 640, y: 200 }
 * ```
 */
export function mapTapToViewport(
	tap: { x: number; y: number; frameWidth: number; frameHeight: number },
	viewport: Viewport,
): { x: number; y: number } {
	const fx = Math.max(0, Math.min(1, tap.x / tap.frameWidth));
	const fy = Math.max(0, Math.min(1, tap.y / tap.frameHeight));
	// Keep the point strictly inside, so a tap on the very edge still lands on
	// the page rather than on the boundary pixel outside it.
	const x = Math.min(viewport.width - 1, Math.max(0, Math.round(fx * viewport.width)));
	const y = Math.min(viewport.height - 1, Math.max(0, Math.round(fy * viewport.height)));
	return { x, y };
}

/**
 * Best guess at the viewport from the frame alone, for when the page could
 * not be measured.
 *
 * The live view captures at `scale` of the CSS viewport, and the capture is
 * in device pixels, so a frame is `css × scale × devicePixelRatio` wide.
 *
 * @param frameWidth - Natural width of the frame
 * @param frameHeight - Natural height of the frame
 * @param devicePixelRatio - DPR the frame was captured at, when known
 * @param scale - The capture's downscale factor
 * @returns The estimated viewport in CSS pixels
 */
export function estimateViewportFromFrame(
	frameWidth: number,
	frameHeight: number,
	devicePixelRatio: number | undefined,
	scale: number,
): Viewport {
	const dpr = devicePixelRatio && devicePixelRatio > 0 ? devicePixelRatio : 1;
	const factor = scale > 0 ? scale * dpr : dpr;
	return { width: Math.round(frameWidth / factor), height: Math.round(frameHeight / factor) };
}

/**
 * Page script that measures the visible viewport in CSS pixels.
 *
 * `visualViewport` is what the extension clips its capture to
 * (`cssVisualViewport` in CDP terms); `clientWidth` is the fallback on pages
 * where it is missing.
 */
export const VIEWPORT_PROBE_SCRIPT =
	'(() => { const v = window.visualViewport; const d = document.documentElement; ' +
	'return { width: (v && v.width) || d.clientWidth || window.innerWidth, ' +
	'height: (v && v.height) || d.clientHeight || window.innerHeight }; })()';

/**
 * Read the result of {@link VIEWPORT_PROBE_SCRIPT} out of an extension reply.
 *
 * @param result - The `result` field of the extension's response
 * @returns The viewport, or null when the reply is not usable
 */
export function parseViewportProbe(result: unknown): Viewport | null {
	const value = (result as { value?: unknown } | null | undefined)?.value as
		| { width?: unknown; height?: unknown }
		| null
		| undefined;
	const width = value?.width;
	const height = value?.height;
	if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null;
	return { width, height };
}

/**
 * Page script that presses one key and performs what the key would do.
 *
 * The extension's `pressKey` dispatches synthetic keyboard events, which
 * pages can listen to but which the browser does not act on: Enter does not
 * submit, Backspace does not delete, Tab does not move focus. For an owner
 * trying to sign in, those defaults are the whole point, so this script
 * dispatches the events (so page handlers still run) and then, unless a
 * handler cancelled the key, carries out the default itself. It runs through
 * `executeJs`, which evaluates with a user gesture.
 *
 * Only reaches focus in the top document and same-origin frames; a field
 * inside a cross-origin iframe is out of its reach.
 *
 * @param key - One of the allowed keys
 * @returns JavaScript source to evaluate in the page
 */
export function keyEffectScript(key: OwnerKey): string {
	const arrowPx = BROWSER_OWNER_INPUT_CONSTANTS.ARROW_SCROLL_PX;
	return `(() => {
	const key = ${JSON.stringify(key)};
	let el = document.activeElement;
	while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
		let inner = null;
		try { inner = el.contentDocument && el.contentDocument.activeElement; } catch (e) { inner = null; }
		if (!inner) break;
		el = inner;
	}
	const target = el || document.body;
	const doc = target.ownerDocument || document;
	const win = doc.defaultView || window;
	const tag = (target.tagName || '').toUpperCase();
	const editable = tag === 'TEXTAREA' || target.isContentEditable ||
		(tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(target.type || ''));
	const opts = { key, code: key, bubbles: true, cancelable: true, composed: true };
	const proceed = target.dispatchEvent(new win.KeyboardEvent('keydown', opts));
	let effect = 'none';
	if (proceed) {
		if (key === 'Enter') {
			target.dispatchEvent(new win.KeyboardEvent('keypress', opts));
			const buttonLike = tag === 'BUTTON' || tag === 'A' || target.getAttribute('role') === 'button' ||
				(tag === 'INPUT' && /^(submit|button|image|reset)$/i.test(target.type || ''));
			if (tag === 'TEXTAREA' || target.isContentEditable) {
				doc.execCommand('insertLineBreak'); effect = 'newline';
			} else if (buttonLike) {
				target.click(); effect = 'clicked';
			} else if (tag === 'INPUT' && target.form) {
				const f = target.form;
				if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.submit();
				effect = 'submitted';
			}
		} else if (key === 'Backspace') {
			if (editable) { doc.execCommand('delete'); effect = 'deleted'; }
		} else if (key === 'Tab') {
			const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
			const all = Array.prototype.filter.call(doc.querySelectorAll(sel), (n) => {
				const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0;
			});
			if (all.length > 0) {
				const i = all.indexOf(target);
				const next = all[(i + 1) % all.length];
				next.focus(); effect = 'focused';
			}
		} else if (key === 'ArrowUp' || key === 'ArrowDown') {
			if (!editable) { win.scrollBy(0, key === 'ArrowUp' ? -${arrowPx} : ${arrowPx}); effect = 'scrolled'; }
		}
	}
	target.dispatchEvent(new win.KeyboardEvent('keyup', opts));
	return { key, effect, target: tag };
})()`;
}

/** Script for the Back control. */
export const HISTORY_BACK_SCRIPT = '(() => { history.back(); return { back: true }; })()';

/**
 * Choose the browser operation for one owner input.
 *
 * Typing uses `insertText`, which inserts at the focused element through CDP
 * the way an IME does: the owner taps the field first, exactly as on a real
 * screen, and needs no selector.
 *
 * @param input - What the owner did
 * @param viewport - The page's viewport in CSS pixels; required for `tap`
 * @returns The operation to dispatch
 * @throws When a tap is planned without a viewport
 */
export function planOwnerInput(input: OwnerInput, viewport?: Viewport): OwnerCommand {
	switch (input.kind) {
		case 'tap': {
			if (!viewport) throw new Error('A tap needs the page viewport');
			const point = mapTapToViewport(input, viewport);
			return {
				tool: 'click',
				params: {
					x: point.x,
					y: point.y,
					reactIdleQuietMs: BROWSER_OWNER_INPUT_CONSTANTS.TAP_IDLE_QUIET_MS,
					reactIdleMaxWaitMs: BROWSER_OWNER_INPUT_CONSTANTS.TAP_IDLE_MAX_WAIT_MS,
				},
			};
		}
		case 'type':
			return { tool: 'insertText', params: { text: input.text } };
		case 'key':
			return { tool: 'executeJs', params: { code: keyEffectScript(input.key) } };
		case 'scroll':
			return { tool: 'scroll', params: { x: 0, y: input.dy } };
		case 'navigate':
			return { tool: 'navigate', params: { url: input.url } };
		case 'back':
			return { tool: 'executeJs', params: { code: HISTORY_BACK_SCRIPT } };
	}
}

/**
 * Describe an owner input for the session's "last action" line.
 *
 * Never includes typed text — only its length.
 *
 * @param input - What the owner did
 * @returns A short sentence
 */
export function describeOwnerInput(input: OwnerInput): string {
	switch (input.kind) {
		case 'tap':
			return 'You tapped the page';
		case 'type':
			return `You typed ${input.text.length} character${input.text.length === 1 ? '' : 's'}`;
		case 'key':
			return `You pressed ${input.key}`;
		case 'scroll':
			return input.dy < 0 ? 'You scrolled up' : 'You scrolled down';
		case 'navigate': {
			let host = '';
			try {
				host = new URL(input.url).host;
			} catch {
				host = '';
			}
			return host ? `You opened ${host}` : 'You opened a page';
		}
		case 'back':
			return 'You went back';
	}
}

/**
 * What may be logged about an owner input: its kind, and for text only its
 * length. Kept here so the controller cannot accidentally log the body.
 *
 * @param input - What the owner did
 * @returns Log-safe fields
 */
export function ownerInputLogFields(input: OwnerInput): Record<string, unknown> {
	switch (input.kind) {
		case 'type':
			return { kind: 'type', length: input.text.length };
		case 'key':
			return { kind: 'key', key: input.key };
		case 'navigate': {
			let host = '';
			try {
				host = new URL(input.url).host;
			} catch {
				host = '';
			}
			return { kind: 'navigate', host };
		}
		default:
			return { kind: input.kind };
	}
}
