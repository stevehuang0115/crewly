/**
 * Tests for the secret redactor (session logs, scrub of logs and history).
 *
 * All secrets below are fake, shaped like the real thing.
 *
 * @module utils/secret-redactor.test
 */

import {
	StreamingSecretRedactor,
	isSecretAssignmentName,
	redactSecrets,
	redactSecretsWithCount,
} from './secret-redactor.js';
import { collectSecretEnvValues } from './secret-env.js';

const FAKE = {
	gemini: ('AIza' + 'SyTESTfakeGeminiKey0123456789abcdefg'),
	openai: ('sk-proj-' + 'TESTfakeOpenAIKey0123456789abcdefghij'),
	deepseek: ('sk-' + '0123456789abcdef0123456789abcdef'),
	anthropic: ('sk-ant-' + 'api03-TESTfakeAnthropicKey0123456789_-abc'),
	slackBot: ('xoxb-' + '1234567890123-1234567890123-TESTfakeSlackBot'),
	slackUser: ('xoxp-' + '1234567890123-TESTfakeSlackUser0000'),
	slackApp: ('xapp-' + '1-A0AC0H8176X-1234567890123-TESTfakeappabcdef0123'),
	ghp: ('ghp_' + 'TESTfakeGithubToken0123456789abcdef'),
	ghPat: ('github_pat_' + '11ABCDEFG0TESTfakeFineGrained_0123456789abcdefghij'),
};

describe('redactSecrets — secret-named assignments', () => {
	it.each([
		['GEMINI_API_KEY', 'anything-at-all-123'],
		['GOOGLE_GENERATIVE_AI_API_KEY', 'plainvalue'],
		['OPENAI_API_KEY', 'x'],
		['ANTHROPIC_API_KEY', 'abc123'],
		['DEEPSEEK_API_KEY', 'abc123'],
		['SLACK_BOT_TOKEN', 'abc123'],
		['SLACK_SIGNING_SECRET', 'abc123'],
		['CREWLY_API_TOKEN', 'abc123'],
		['CREWLY_RELAY_TOKEN', 'abc123'],
		['DB_PASSWORD', 'hunter2'],
		['SSH_PRIVATE_KEY', 'abc123'],
		['github_token', 'abc123'],
	])('masks the value of %s', (name, value) => {
		const out = redactSecrets(`export ${name}=${value} && run`);
		expect(out).toBe(`export ${name}=[REDACTED] && run`);
	});

	it('keeps quotes around a masked quoted value', () => {
		expect(redactSecrets(`export OPENAI_API_KEY="hello-world-value"`)).toBe('export OPENAI_API_KEY="[REDACTED]"');
		expect(redactSecrets(`API_KEY='v4lue'`)).toBe(`API_KEY='[REDACTED]'`);
	});

	it.each([
		'TOKEN_COUNT=5',
		'MAX_TOKENS=4096',
		'CREWLY_SESSION_NAME=dev-1',
		'CREWLY_ROLE=developer',
		'HISTFILE=/dev/null',
		'TOKENIZER=cl100k',
		'KEYBOARD=us',
		'OPENAI_API_KEY=$OPENAI_API_KEY',
		'the tokens=12 in this run',
	])('does not touch ordinary text: %s', (text) => {
		expect(redactSecretsWithCount(text)).toEqual({ text, count: 0 });
	});

	it('names the decision: any value of a secret name is masked, even a short one', () => {
		expect(redactSecrets('TOKEN=5')).toBe('TOKEN=[REDACTED]');
	});
});

describe('redactSecrets — token shapes', () => {
	it.each(Object.entries(FAKE))('masks a raw %s token in prose', (_label, token) => {
		const out = redactSecrets(`here it is: ${token} (done)`);
		expect(out).not.toContain(token);
		expect(out).toMatch(/^here it is: \[REDACTED[^\]]*\] \(done\)$/);
	});

	it('masks tokens inside JSON and URLs', () => {
		const out = redactSecrets(`{"key":"${FAKE.gemini}"} https://x.test/?k=${FAKE.ghp}`);
		expect(out).not.toContain(FAKE.gemini);
		expect(out).not.toContain(FAKE.ghp);
	});

	it('leaves look-alikes alone', () => {
		for (const text of ['ask-me-anything-please-now-ok', 'task-0123456789abcdefghij', 'AIza', 'xoxb-short', 'sk-short']) {
			expect(redactSecretsWithCount(text).count).toBe(0);
		}
	});
});

describe('redactSecrets — known values', () => {
	it('masks the exact value of a held secret that no pattern would see', () => {
		const signing = '0123456789abcdef0123456789abcdef';
		const secrets = collectSecretEnvValues({ SLACK_SIGNING_SECRET: signing });
		const out = redactSecrets(`sig ${signing} again ${signing}`, secrets);
		expect(out).toBe('sig [REDACTED SLACK_SIGNING_SECRET] again [REDACTED SLACK_SIGNING_SECRET]');
		expect(redactSecretsWithCount(`sig ${signing} again ${signing}`, secrets).count).toBe(2);
	});
});

describe('redactSecretsWithCount — idempotence', () => {
	it('counts on the first pass and finds nothing on the second', () => {
		const text = [
			`export GEMINI_API_KEY="${FAKE.gemini}"`,
			`SLACK_APP_TOKEN=${FAKE.slackApp}`,
			`raw ${FAKE.anthropic} and ${FAKE.slackBot}`,
			'password: hunter22222',
		].join('\n');
		const first = redactSecretsWithCount(text);
		expect(first.count).toBeGreaterThanOrEqual(4);
		for (const v of Object.values(FAKE)) expect(first.text).not.toContain(v);

		const second = redactSecretsWithCount(first.text);
		expect(second).toEqual({ text: first.text, count: 0 });
	});
});

describe('isSecretAssignmentName', () => {
	it('matches secret names and families, not counters', () => {
		expect(isSecretAssignmentName('SLACK_USER_TOKEN')).toBe(true);
		expect(isSecretAssignmentName('CREWLY_CLOUD_TOKEN')).toBe(true);
		expect(isSecretAssignmentName('gemini_api_key')).toBe(true);
		expect(isSecretAssignmentName('TOKEN_COUNT')).toBe(false);
		expect(isSecretAssignmentName('CREWLY_API_URL')).toBe(false);
	});
});

describe('StreamingSecretRedactor', () => {
	/** Feeds text in fixed-size pieces and returns the concatenated output */
	function stream(text: string, size: number, redactor = new StreamingSecretRedactor()): string {
		let out = '';
		for (let i = 0; i < text.length; i += size) out += redactor.push(text.slice(i, i + size));
		return out + redactor.flush();
	}

	const text =
		`$ export GEMINI_API_KEY=${FAKE.gemini}\n` +
		`bot ${FAKE.slackBot} app ${FAKE.slackApp}\n` +
		`ANTHROPIC_API_KEY="${FAKE.anthropic}" ok\n$ `;

	it.each([1, 2, 3, 7, 16, 1000])('masks secrets split at every boundary (chunk size %i)', (size) => {
		const out = stream(text, size);
		for (const v of Object.values(FAKE)) expect(out).not.toContain(v);
		expect(out).toBe(redactSecrets(text));
	});

	it('emits complete words immediately and holds back only the last one', () => {
		const r = new StreamingSecretRedactor();
		expect(r.push('hello wor')).toBe('hello ');
		expect(r.push('ld\n')).toBe('world\n');
		expect(r.push('prompt')).toBe('');
		expect(r.flush()).toBe('prompt');
		expect(r.flush()).toBe('');
	});

	it('masks a known value split across chunks', () => {
		const signing = 'abcdef0123456789abcdef0123456789';
		const r = new StreamingSecretRedactor(collectSecretEnvValues({ SLACK_SIGNING_SECRET: signing }));
		const out = stream(`secret is ${signing} end`, 5, r);
		expect(out).toBe('secret is [REDACTED SLACK_SIGNING_SECRET] end');
	});

	it('keeps the carry bounded on a long run without whitespace and loses no text', () => {
		const r = new StreamingSecretRedactor([], 64);
		const run = 'x'.repeat(1000);
		let out = '';
		for (const ch of run) {
			out += r.push(ch);
			expect((r as unknown as { carry: string }).carry.length).toBeLessThanOrEqual(64);
		}
		out += r.flush();
		expect(out).toBe(run);
	});

	it('does not split a token near a forced cut when a separator precedes it', () => {
		const r = new StreamingSecretRedactor([], 128);
		const filler = 'a'.repeat(200);
		const out = stream(`${filler}|${FAKE.gemini}`, 1, r);
		expect(out).not.toContain(FAKE.gemini);
	});

	it('handles 1 MB of output in one linear pass', () => {
		const big = `${'lorem ipsum dolor sit amet '.repeat(40000)}${FAKE.deepseek}\n`;
		const started = Date.now();
		const out = stream(big, 4096);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(out).not.toContain(FAKE.deepseek);
		expect(out.length).toBeGreaterThan(big.length - 100);
	});
});
