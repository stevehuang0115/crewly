/**
 * Tests for the browser outbound guard (2026-10-03 LinkedIn post incident).
 */

import {
	actionFingerprint,
	descriptorOf,
	draftTextOf,
	isSocialOrMessagingSite,
	isSubmitKey,
	labelsOf,
	matchOutbound,
	scriptActs,
	toWords,
	typedTextSubmits,
} from './browser-outbound-guard.js';
import { matchIrreversible } from './browser-session.service.js';

const LINKEDIN = { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7/' };
const X = { url: 'https://x.com/home' };
const DOCS = { url: 'https://docs.example.com/guide' };

describe('browser-outbound-guard', () => {
	describe('LinkedIn/X posting paths are held', () => {
		it('click on the comment box submit button (the "__submit" selector that slipped through)', () => {
			expect(matchOutbound('click', { selector: 'button.comments-comment-box__submit-button' }, LINKEDIN)).toBe('submitting');
		});

		it('a control whose whole label is Reply / Comment / Post / Tweet', () => {
			expect(matchOutbound('click', { text: 'Reply' }, LINKEDIN)).toBe('replying');
			expect(matchOutbound('click', { selector: 'button[aria-label="Comment"]' }, LINKEDIN)).toBe('replying');
			expect(matchOutbound('click', { selector: 'button:has-text("Post")' }, LINKEDIN)).toBe('publishing');
			expect(matchOutbound('click', { selector: '[data-testid="tweetButton"]' }, X)).toBe('publishing');
			expect(matchOutbound('click', { selector: '[data-testid="tweetButtonInline"]' }, X)).toBe('publishing');
		});

		it('click by coordinates or element ref names no control — held on a social site', () => {
			expect(matchOutbound('click', { x: 812, y: 455 }, LINKEDIN)).toMatch(/unnamed control/);
			expect(matchOutbound('click', { ref: 'e42' }, LINKEDIN)).toMatch(/unnamed control/);
		});

		it('typing text that ends in a newline, or with a submit flag', () => {
			expect(matchOutbound('type', { selector: '.ql-editor', text: 'Agree. Absorption is the other half…\n' }, LINKEDIN)).toBe('submitting typed text');
			expect(matchOutbound('insertText', { text: 'hello', submit: true }, LINKEDIN)).toBe('submitting typed text');
			expect(matchOutbound('type', { selector: '.ql-editor', text: 'draft only' }, LINKEDIN)).toBeNull();
		});

		it('every submitting key: Enter, Return, Ctrl/Cmd+Enter, modifiers array', () => {
			for (const key of ['Enter', 'NumpadEnter', 'Return', 'Ctrl+Enter', 'Cmd+Enter', 'Control+Enter', 'Meta+Enter', '\n']) {
				expect(matchOutbound('pressKey', { key }, LINKEDIN)).toBe('submitting with a keystroke');
			}
			expect(matchOutbound('pressKey', { key: 'Enter', modifiers: ['Meta'] }, DOCS)).toBe('submitting with a keystroke');
			expect(matchOutbound('pressKey', { key: 'Tab' }, LINKEDIN)).toBeNull();
		});

		it('scripts that click a submit control in any spelling, or send a writing request', () => {
			expect(matchOutbound('executeJs', { code: "document.querySelector('.comments-comment-box__submit-button').click()" }, LINKEDIN)).toBe('submitting');
			expect(matchOutbound('executeJs', { code: "[...document.querySelectorAll('button')].find(b => b.innerText === 'Reply').click()" }, LINKEDIN)).toBe('replying');
			expect(matchOutbound('executeJs', { code: "HTMLElement.prototype.click.call(document.querySelector('[aria-label=\"Post\"]'))" }, LINKEDIN)).toBe('publishing');
			// A word in a comment or an identifier is not a control: `x.send()` / `// send`.
			expect(matchOutbound('executeJs', { code: "el['click'](); // send" }, LINKEDIN)).toBeNull();
			expect(matchOutbound('executeJs', { code: "document.querySelector('.msg-form__send-button').click()" }, LINKEDIN)).toBe('sending');
			expect(matchOutbound('executeJs', { code: "fetch('/voyager/api/comments', { method: 'POST', body })" }, LINKEDIN)).toBe('sending a request');
		});
	});

	describe('reading is NOT held (review of #1014)', () => {
		it('reading a tweet: clicking the tweet, its permalink or "Show more"', () => {
			expect(matchOutbound('click', { selector: 'article[data-testid="tweet"]' }, X)).toBeNull();
			expect(matchOutbound('click', { selector: 'a[href*="/status/"] time' }, X)).toBeNull();
			expect(matchOutbound('click', { text: 'Show more' }, X)).toBeNull();
			expect(matchIrreversible('click', { selector: 'article[data-testid="tweet"]' }, X)).toBeNull();
		});

		it('LinkedIn comment items: opening, expanding, reading', () => {
			expect(matchOutbound('click', { selector: '.comments-comment-item__main-content' }, LINKEDIN)).toBeNull();
			expect(matchOutbound('click', { selector: 'button.comments-comments-list__load-more-comments-button' }, LINKEDIN)).toBeNull();
			expect(matchIrreversible('click', { selector: '.comments-comment-item__main-content' }, LINKEDIN)).toBeNull();
		});

		it('a "See more" script and a read-only fetch', () => {
			const seeMore = "[...document.querySelectorAll('button')].find(b => b.innerText.includes('See more')).click()";
			expect(matchOutbound('executeJs', { code: seeMore }, LINKEDIN)).toBeNull();
			expect(matchIrreversible('executeJs', { code: seeMore }, LINKEDIN)).toBeNull();
			const readFetch = "return fetch('/voyager/api/feed/updates').then(r => r.json())";
			expect(matchOutbound('executeJs', { code: readFetch }, LINKEDIN)).toBeNull();
			expect(matchIrreversible('executeJs', { code: readFetch }, LINKEDIN)).toBeNull();
		});

		it('code identifiers are not split into trigger words', () => {
			const code = "const postCount = document.querySelectorAll('.commentsList li').length; document.querySelector('.tab-2').click(); return postCount";
			expect(matchOutbound('executeJs', { code }, LINKEDIN)).toBeNull();
		});

		it('unnamed clicks and "Share" off social sites', () => {
			expect(matchOutbound('click', { x: 10, y: 10 }, DOCS)).toBeNull();
			expect(matchOutbound('click', { text: 'Share' }, DOCS)).toBeNull();
			expect(matchOutbound('click', { text: 'Share' }, LINKEDIN)).toBe('sharing');
		});
	});

	describe('second review of #1014', () => {
		it('a form submit is held anywhere; a writing fetch is held however its options are written', () => {
			expect(matchOutbound('executeJs', { code: 'document.forms[0].requestSubmit()' }, DOCS)).toBe('submitting');
			expect(matchOutbound('executeJs', { code: "fetch(url(), {method:'POST'})" }, DOCS)).toBe('sending a request');
			expect(matchOutbound('executeJs', { code: 'const opts = { method: m, body }; return fetch(endpoint(), opts)' }, DOCS)).toBe('sending a request');
			expect(matchOutbound('executeJs', { code: "return fetch('/api/feed', { method: 'GET' }).then(r => r.json())" }, DOCS)).toBeNull();
		});

		it('no longer holds a read-only XHR (`x.send()`) or Reddit\'s shreddit-post "See more"', () => {
			const xhr = "const x = new XMLHttpRequest(); x.open('GET', '/api/me', false); x.send(); return x.responseText";
			expect(matchIrreversible('executeJs', { code: xhr }, { url: 'https://www.reddit.com/r/x' })).toBeNull();
			expect(matchIrreversible('click', { selector: 'shreddit-post button.see-more', text: 'See more' }, { url: 'https://www.reddit.com/r/x' })).toBeNull();
			const seeMore = "document.querySelector('shreddit-post').shadowRoot.querySelector('button[aria-label=\"See more\"]').click()";
			expect(matchIrreversible('executeJs', { code: seeMore }, { url: 'https://www.reddit.com/r/x' })).toBeNull();
		});
	});

	describe('helpers', () => {
		it('recognises social and messaging hosts and their subdomains', () => {
			expect(isSocialOrMessagingSite('https://www.linkedin.com/in/x')).toBe(true);
			expect(isSocialOrMessagingSite('https://mail.google.com/mail/u/0')).toBe(true);
			expect(isSocialOrMessagingSite('https://myteam.slack.com/messages')).toBe(true);
			expect(isSocialOrMessagingSite('x.com/home')).toBe(true);
			expect(isSocialOrMessagingSite('https://notlinkedin.com.evil.io')).toBe(false);
			expect(isSocialOrMessagingSite(undefined)).toBe(false);
		});

		it('splits CSS names at punctuation, not camelCase', () => {
			expect(toWords('comments-comment-box__submit-button')).toBe('comments comment box submit button');
			expect(toWords('postButton')).toBe('postButton');
		});

		it('labels from text, aria-label, has-text and quoted strings', () => {
			expect(labelsOf({ selector: 'button[aria-label="Post"]' })).toEqual(['post']);
			expect(labelsOf({ text: ' Reply ' })).toEqual(['reply']);
			expect(labelsOf({ selector: 'text=Send' })).toContain('send');
		});

		it('small predicates', () => {
			expect(descriptorOf({ selector: 'a', ariaLabel: 'Send' })).toBe('a Send');
			expect(isSubmitKey('Shift')).toBe(false);
			expect(typedTextSubmits({ text: 'a\r' })).toBe(true);
			expect(scriptActs('return 1')).toBe(false);
			expect(scriptActs("fetch('/x')")).toBe(false);
		});

		it('draft text and fingerprints', () => {
			expect(draftTextOf('type', { text: '  Agree.  ' })).toBe('Agree.');
			expect(draftTextOf('type', { selector: 'input#password', text: 'hunter2' })).toBeUndefined();
			expect(draftTextOf('click', { text: 'Post' })).toBeUndefined();
			expect(actionFingerprint('click', { selector: 'a' })).toBe(actionFingerprint('click', { selector: 'a', tabId: 3 }));
			expect(actionFingerprint('click', { selector: 'a' })).not.toBe(actionFingerprint('click', { selector: 'b' }));
		});
	});
});
