/**
 * Tests for owner browser input: validation, tap mapping, and which browser
 * operation each kind of input becomes.
 *
 * @module services/browser/owner-browser-input.test
 */

import {
	parseOwnerInput,
	mapTapToViewport,
	estimateViewportFromFrame,
	parseViewportProbe,
	planOwnerInput,
	describeOwnerInput,
	ownerInputLogFields,
	normalizeOwnerUrl,
	keyEffectScript,
	isOwnerKey,
	HISTORY_BACK_SCRIPT,
	type OwnerInput,
} from './owner-browser-input.js';
import { BROWSER_OWNER_INPUT_CONSTANTS, BROWSER_SESSION_CONSTANTS } from '../../constants.js';

describe('parseOwnerInput', () => {
	it('accepts each kind', () => {
		expect(parseOwnerInput({ kind: 'tap', x: 1, y: 2, frameWidth: 10, frameHeight: 10 })).toEqual({
			ok: true,
			input: { kind: 'tap', x: 1, y: 2, frameWidth: 10, frameHeight: 10 },
		});
		expect(parseOwnerInput({ kind: 'type', text: 'abc' })).toEqual({ ok: true, input: { kind: 'type', text: 'abc' } });
		expect(parseOwnerInput({ kind: 'key', key: 'Enter' })).toEqual({ ok: true, input: { kind: 'key', key: 'Enter' } });
		expect(parseOwnerInput({ kind: 'scroll', dy: -300 })).toEqual({ ok: true, input: { kind: 'scroll', dy: -300 } });
		expect(parseOwnerInput({ kind: 'navigate', url: 'login.gov' })).toEqual({
			ok: true,
			input: { kind: 'navigate', url: 'https://login.gov/' },
		});
		expect(parseOwnerInput({ kind: 'back' })).toEqual({ ok: true, input: { kind: 'back' } });
	});

	it('refuses an unknown kind or a missing body', () => {
		expect(parseOwnerInput({ kind: 'drag' }).ok).toBe(false);
		expect(parseOwnerInput(undefined).ok).toBe(false);
	});

	it('refuses a tap without numbers, on an empty frame, or outside the frame', () => {
		expect(parseOwnerInput({ kind: 'tap', x: '1', y: 2, frameWidth: 10, frameHeight: 10 }).ok).toBe(false);
		expect(parseOwnerInput({ kind: 'tap', x: 1, y: 2, frameWidth: 0, frameHeight: 10 }).ok).toBe(false);
		expect(parseOwnerInput({ kind: 'tap', x: 11, y: 2, frameWidth: 10, frameHeight: 10 }).ok).toBe(false);
		expect(parseOwnerInput({ kind: 'tap', x: NaN, y: 2, frameWidth: 10, frameHeight: 10 }).ok).toBe(false);
	});

	it('refuses empty or oversized text, and never quotes it back', () => {
		expect(parseOwnerInput({ kind: 'type', text: '' }).ok).toBe(false);
		const long = 'p'.repeat(BROWSER_OWNER_INPUT_CONSTANTS.MAX_TEXT_LENGTH + 1);
		const res = parseOwnerInput({ kind: 'type', text: long });
		expect(res.ok).toBe(false);
		expect(JSON.stringify(res)).not.toContain('ppppp');
	});

	it('only allows the keys the control bar offers', () => {
		for (const key of BROWSER_OWNER_INPUT_CONSTANTS.KEYS) {
			expect(parseOwnerInput({ kind: 'key', key }).ok).toBe(true);
		}
		expect(parseOwnerInput({ kind: 'key', key: 'F5' }).ok).toBe(false);
		expect(isOwnerKey('Meta')).toBe(false);
	});

	it('clamps a scroll and refuses a zero one', () => {
		expect(parseOwnerInput({ kind: 'scroll', dy: 0 }).ok).toBe(false);
		expect(parseOwnerInput({ kind: 'scroll', dy: 1e9 })).toEqual({
			ok: true,
			input: { kind: 'scroll', dy: BROWSER_OWNER_INPUT_CONSTANTS.MAX_SCROLL_PX },
		});
	});

	it('refuses a URL that is not http(s)', () => {
		expect(parseOwnerInput({ kind: 'navigate', url: 'javascript:alert(1)' }).ok).toBe(false);
		expect(parseOwnerInput({ kind: 'navigate', url: 'file:///etc/passwd' }).ok).toBe(false);
		expect(parseOwnerInput({ kind: 'navigate', url: '' }).ok).toBe(false);
	});
});

describe('normalizeOwnerUrl', () => {
	it('adds https to a bare host and keeps an explicit scheme', () => {
		expect(normalizeOwnerUrl('dmca.copyright.gov/osp')).toBe('https://dmca.copyright.gov/osp');
		expect(normalizeOwnerUrl('http://example.com')).toBe('http://example.com/');
		expect(normalizeOwnerUrl('chrome://settings')).toBeNull();
	});
});

describe('mapTapToViewport', () => {
	it('maps a half-scale frame on a 2x display (frame pixels = CSS pixels)', () => {
		// 1280x800 CSS viewport, DPR 2, scale 0.5 -> 1280x800 frame
		expect(mapTapToViewport({ x: 640, y: 400, frameWidth: 1280, frameHeight: 800 }, { width: 1280, height: 800 })).toEqual({
			x: 640,
			y: 400,
		});
	});

	it('maps a half-scale frame on a 1x display (frame is half the viewport)', () => {
		expect(mapTapToViewport({ x: 320, y: 100, frameWidth: 640, frameHeight: 400 }, { width: 1280, height: 800 })).toEqual({
			x: 640,
			y: 200,
		});
	});

	it('maps a frame the extension could not downscale (device pixels)', () => {
		// DPR 2, no scale -> 2560x1600 frame over a 1280x800 viewport
		expect(mapTapToViewport({ x: 2000, y: 1000, frameWidth: 2560, frameHeight: 1600 }, { width: 1280, height: 800 })).toEqual({
			x: 1000,
			y: 500,
		});
	});

	it('keeps an edge tap inside the viewport', () => {
		expect(mapTapToViewport({ x: 640, y: 400, frameWidth: 640, frameHeight: 400 }, { width: 1280, height: 800 })).toEqual({
			x: 1279,
			y: 799,
		});
		expect(mapTapToViewport({ x: 0, y: 0, frameWidth: 640, frameHeight: 400 }, { width: 1280, height: 800 })).toEqual({
			x: 0,
			y: 0,
		});
	});
});

describe('estimateViewportFromFrame', () => {
	it('undoes the capture scale and the device pixel ratio', () => {
		expect(estimateViewportFromFrame(1280, 800, 2, BROWSER_SESSION_CONSTANTS.FRAME_SCALE)).toEqual({ width: 1280, height: 800 });
		expect(estimateViewportFromFrame(640, 400, 1, 0.5)).toEqual({ width: 1280, height: 800 });
		expect(estimateViewportFromFrame(640, 400, undefined, 0.5)).toEqual({ width: 1280, height: 800 });
	});
});

describe('parseViewportProbe', () => {
	it('reads the executeJs result shape', () => {
		expect(parseViewportProbe({ value: { width: 1280, height: 720 } })).toEqual({ width: 1280, height: 720 });
	});

	it('is null for anything unusable', () => {
		expect(parseViewportProbe(null)).toBeNull();
		expect(parseViewportProbe({ value: null })).toBeNull();
		expect(parseViewportProbe({ value: { width: 0, height: 720 } })).toBeNull();
	});
});

describe('planOwnerInput', () => {
	const vp = { width: 1280, height: 800 };

	it('taps become a coordinate click in CSS pixels', () => {
		expect(planOwnerInput({ kind: 'tap', x: 320, y: 200, frameWidth: 640, frameHeight: 400 }, vp)).toEqual({
			tool: 'click',
			params: {
				x: 640,
				y: 400,
				// The owner is looking at the page: no 2 s wait for it to go idle.
				reactIdleQuietMs: BROWSER_OWNER_INPUT_CONSTANTS.TAP_IDLE_QUIET_MS,
				reactIdleMaxWaitMs: BROWSER_OWNER_INPUT_CONSTANTS.TAP_IDLE_MAX_WAIT_MS,
			},
		});
	});

	it('refuses to plan a tap without a viewport', () => {
		expect(() => planOwnerInput({ kind: 'tap', x: 1, y: 1, frameWidth: 2, frameHeight: 2 })).toThrow();
	});

	it('typing inserts at the focused element, with no selector', () => {
		expect(planOwnerInput({ kind: 'type', text: 's3cret' })).toEqual({ tool: 'insertText', params: { text: 's3cret' } });
	});

	it('keys run the key-effect script', () => {
		const cmd = planOwnerInput({ kind: 'key', key: 'Enter' });
		expect(cmd.tool).toBe('executeJs');
		expect(cmd.params.code).toBe(keyEffectScript('Enter'));
	});

	it('scroll, navigate and back map to scroll, navigate and history.back', () => {
		expect(planOwnerInput({ kind: 'scroll', dy: 500 })).toEqual({ tool: 'scroll', params: { x: 0, y: 500 } });
		expect(planOwnerInput({ kind: 'navigate', url: 'https://login.gov/' })).toEqual({
			tool: 'navigate',
			params: { url: 'https://login.gov/' },
		});
		expect(planOwnerInput({ kind: 'back' })).toEqual({ tool: 'executeJs', params: { code: HISTORY_BACK_SCRIPT } });
	});
});

describe('describeOwnerInput / ownerInputLogFields', () => {
	const secret = 'correct-horse-battery-staple';

	it('reports only how many characters were typed', () => {
		const input: OwnerInput = { kind: 'type', text: secret };
		expect(describeOwnerInput(input)).toBe(`You typed ${secret.length} characters`);
		expect(describeOwnerInput({ kind: 'type', text: 'a' })).toBe('You typed 1 character');
		expect(JSON.stringify(ownerInputLogFields(input))).not.toContain(secret);
		expect(ownerInputLogFields(input)).toEqual({ kind: 'type', length: secret.length });
	});

	it('names the host, not the full URL, for navigation', () => {
		const input: OwnerInput = { kind: 'navigate', url: 'https://secure.login.gov/?request_id=abc123' };
		expect(describeOwnerInput(input)).toBe('You opened secure.login.gov');
		expect(JSON.stringify(ownerInputLogFields(input))).not.toContain('abc123');
	});

	it('describes the rest plainly', () => {
		expect(describeOwnerInput({ kind: 'tap', x: 1, y: 1, frameWidth: 2, frameHeight: 2 })).toBe('You tapped the page');
		expect(describeOwnerInput({ kind: 'key', key: 'Tab' })).toBe('You pressed Tab');
		expect(describeOwnerInput({ kind: 'scroll', dy: -5 })).toBe('You scrolled up');
		expect(describeOwnerInput({ kind: 'scroll', dy: 5 })).toBe('You scrolled down');
		expect(describeOwnerInput({ kind: 'back' })).toBe('You went back');
	});
});

describe('keyEffectScript (run against a minimal page)', () => {
	/** Keyboard event with a key, which Node's Event lacks. */
	class FakeKeyboardEvent extends Event {
		key: string;
		constructor(type: string, init: { key: string; bubbles?: boolean; cancelable?: boolean }) {
			super(type, init);
			this.key = init.key;
		}
	}

	/** Just enough of an element for the script: events, tag, form, click. */
	class FakeElement extends EventTarget {
		isContentEditable = false;
		form: FakeForm | null = null;
		clicks = 0;
		constructor(
			public tagName: string,
			public type = '',
			private readonly doc: FakePage,
		) {
			super();
		}
		get ownerDocument(): FakePage {
			return this.doc;
		}
		getAttribute(): string | null {
			return null;
		}
		click(): void {
			this.clicks += 1;
		}
		focus(): void {
			this.doc.activeElement = this;
		}
		getBoundingClientRect(): { width: number; height: number } {
			return { width: 10, height: 10 };
		}
	}

	/** A form that records requestSubmit. */
	class FakeForm {
		submits = 0;
		requestSubmit(): void {
			this.submits += 1;
		}
	}

	/** The page: focus, execCommand, and the window the script reads. */
	class FakePage extends EventTarget {
		activeElement: FakeElement | null = null;
		body: FakeElement;
		execCommand = jest.fn(() => true);
		elements: FakeElement[] = [];
		defaultView = { KeyboardEvent: FakeKeyboardEvent, scrollBy: jest.fn() };
		constructor() {
			super();
			this.body = new FakeElement('BODY', '', this);
		}
		add(tag: string, type = '', form: FakeForm | null = null): FakeElement {
			const el = new FakeElement(tag, type, this);
			el.form = form;
			this.elements.push(el);
			return el;
		}
		querySelectorAll(): FakeElement[] {
			return this.elements;
		}
	}

	/** Evaluate the script in the page, the way the extension would. */
	function run(page: FakePage, key: Parameters<typeof keyEffectScript>[0]): { key: string; effect: string; target: string } {
		const fn = new Function('document', 'window', `return ${keyEffectScript(key)};`);
		return fn(page, page.defaultView) as { key: string; effect: string; target: string };
	}

	it('Enter in a form field submits the form', () => {
		const page = new FakePage();
		const form = new FakeForm();
		page.add('INPUT', 'email', form).focus();

		expect(run(page, 'Enter').effect).toBe('submitted');
		expect(form.submits).toBe(1);
	});

	it('Enter on a button clicks it', () => {
		const page = new FakePage();
		const btn = page.add('BUTTON');
		btn.focus();

		expect(run(page, 'Enter').effect).toBe('clicked');
		expect(btn.clicks).toBe(1);
	});

	it('a page that cancels the key keeps the default from happening', () => {
		const page = new FakePage();
		const form = new FakeForm();
		const input = page.add('INPUT', 'text', form);
		input.addEventListener('keydown', (e) => e.preventDefault());
		input.focus();

		expect(run(page, 'Enter').effect).toBe('none');
		expect(form.submits).toBe(0);
	});

	it('Backspace deletes in a text field only', () => {
		const page = new FakePage();
		const pw = page.add('INPUT', 'password');
		const btn = page.add('BUTTON');
		pw.focus();
		expect(run(page, 'Backspace').effect).toBe('deleted');
		expect(page.execCommand).toHaveBeenCalledWith('delete');

		btn.focus();
		expect(run(page, 'Backspace').effect).toBe('none');
	});

	it('Tab moves focus to the next field', () => {
		const page = new FakePage();
		const user = page.add('INPUT', 'email');
		const pass = page.add('INPUT', 'password');
		user.focus();

		expect(run(page, 'Tab').effect).toBe('focused');
		expect(page.activeElement).toBe(pass);
	});

	it('arrows scroll when focus is not in a field; Escape only dispatches', () => {
		const page = new FakePage();
		const seen: string[] = [];
		page.body.addEventListener('keydown', (e) => seen.push((e as FakeKeyboardEvent).key));

		expect(run(page, 'ArrowDown').effect).toBe('scrolled');
		expect(page.defaultView.scrollBy).toHaveBeenCalledWith(0, BROWSER_OWNER_INPUT_CONSTANTS.ARROW_SCROLL_PX);
		expect(run(page, 'Escape')).toEqual({ key: 'Escape', effect: 'none', target: 'BODY' });
		expect(seen).toEqual(['ArrowDown', 'Escape']);
	});
});
