/**
 * Tests for the browser outbound guard (2026-10-03 LinkedIn post incident).
 */

import {
	actionFingerprint,
	descriptorOf,
	draftTextOf,
	isSocialOrMessagingSite,
	isSubmitKey,
	matchOutbound,
	scriptActs,
	toWords,
	typedTextSubmits,
} from './browser-outbound-guard.js';

const LINKEDIN = { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7/' };
const DOCS = { url: 'https://docs.example.com/guide' };

describe('browser-outbound-guard', () => {
	describe('LinkedIn-like posting paths are all held', () => {
		it('click on the comment box submit button (the "__submit" selector that slipped through)', () => {
			expect(matchOutbound('click', { selector: 'button.comments-comment-box__submit-button' }, LINKEDIN)).toBe('submitting');
		});

		it('click on "Reply" / "Comment" / "Post" by text or aria label', () => {
			expect(matchOutbound('click', { text: 'Reply' }, LINKEDIN)).toBe('replying');
			expect(matchOutbound('click', { selector: 'button[aria-label="Comment"]' }, LINKEDIN)).toBe('replying');
			expect(matchOutbound('click', { selector: 'button:has-text("Post")' }, LINKEDIN)).toBe('publishing');
			expect(matchOutbound('click', { selector: '.share-actions__primary-action' }, LINKEDIN)).toBe('sharing');
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

		it('page scripts that act on a social site, in any click spelling', () => {
			for (const code of [
				"document.querySelector('.comments-comment-box__submit-button').click()",
				"[...document.querySelectorAll('button')].find(b => b.innerText === 'Reply').click()",
				'HTMLElement.prototype.click.call(el)',
				"el['click']()",
				"document.execCommand('insertText', false, 'hi')",
			]) {
				expect(matchOutbound('executeJs', { code }, LINKEDIN)).toBe('acting on a social or messaging site');
			}
			// Reading is fine.
			expect(matchOutbound('executeJs', { code: 'return document.title' }, LINKEDIN)).toBeNull();
		});
	});

	describe('elsewhere stays usable', () => {
		it('unnamed clicks and acting scripts off social sites are judged by their words', () => {
			expect(matchOutbound('click', { x: 10, y: 10 }, DOCS)).toBeNull();
			expect(matchOutbound('executeJs', { code: "document.querySelector('.tab-2').click()" }, DOCS)).toBeNull();
			expect(matchOutbound('executeJs', { code: "document.querySelector('.form__submit').click()" }, DOCS)).toBe('submitting');
		});

		it('"share" only counts on social sites', () => {
			expect(matchOutbound('click', { text: 'Share' }, DOCS)).toBeNull();
			expect(matchOutbound('click', { text: 'Share' }, LINKEDIN)).toBe('sharing');
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

		it('splits CSS names into words', () => {
			expect(toWords('comments-comment-box__submit-button')).toBe('comments comment box submit button');
			expect(toWords('postButton')).toBe('post Button');
		});

		it('small predicates', () => {
			expect(descriptorOf({ selector: 'a', ariaLabel: 'Send' })).toBe('a Send');
			expect(isSubmitKey('Shift')).toBe(false);
			expect(typedTextSubmits({ text: 'a\r' })).toBe(true);
			expect(scriptActs('return 1')).toBe(false);
		});

		it('draft text and fingerprints', () => {
			expect(draftTextOf('type', { text: '  Agree.  ' })).toBe('Agree.');
			expect(draftTextOf('click', { text: 'Post' })).toBeUndefined();
			expect(actionFingerprint('click', { selector: 'a' })).toBe(actionFingerprint('click', { selector: 'a', tabId: 3 }));
			expect(actionFingerprint('click', { selector: 'a' })).not.toBe(actionFingerprint('click', { selector: 'b' }));
		});
	});
});
