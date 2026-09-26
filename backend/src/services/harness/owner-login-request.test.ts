/**
 * Tests for owner login request recognition (DM trigger + skill evidence).
 */

import {
	isOwnerLoginRequestEvidence,
	normaliseLoginText,
	parseOwnerLoginRequest,
	resolveHarnessName,
} from './owner-login-request.js';

describe('resolveHarnessName', () => {
	it('maps names and aliases to harness ids', () => {
		expect(resolveHarnessName('claude')).toBe('claude-code');
		expect(resolveHarnessName('Claude Code')).toBe('claude-code');
		expect(resolveHarnessName('claude-code')).toBe('claude-code');
		expect(resolveHarnessName('codex')).toBe('codex-cli');
		expect(resolveHarnessName('codex cli')).toBe('codex-cli');
		expect(resolveHarnessName('antigravity')).toBe('antigravity-cli');
		expect(resolveHarnessName('agy')).toBe('antigravity-cli');
		expect(resolveHarnessName('gemini')).toBe('gemini-cli');
		expect(resolveHarnessName('cursor')).toBeNull();
	});
});

describe('normaliseLoginText', () => {
	it('drops Slack mention and link markup, quotes and extra spaces', () => {
		expect(normaliseLoginText('<@U123ABC>  重新登录   Claude ')).toBe('重新登录 claude');
		expect(normaliseLoginText('「登录 codex」')).toBe('登录 codex');
		expect(normaliseLoginText('<mailto:a@b.c|a@b.c>')).toBe('a@b.c');
	});
});

describe('parseOwnerLoginRequest — Chinese', () => {
	it.each([
		['重新登录 claude', 'claude-code', false],
		['重新登录claude', 'claude-code', false],
		['帮我重新登陆claude code', 'claude-code', false],
		['登录 codex', 'codex-cli', false],
		['登录一下 codex', null, false],
		['请重新登录 codex 吧', 'codex-cli', false],
		['换个账号登录 claude', 'claude-code', true],
		['换一个账号登录 claude code', 'claude-code', true],
		['用另一个账号登录 claude', 'claude-code', true],
		['claude 重新登录', 'claude-code', false],
		['claude code 登录一下', 'claude-code', false],
		['把 claude 重新登录一下', 'claude-code', false],
		['给 claude 换个账号', 'claude-code', true],
		['codex 换账号登录', 'codex-cli', true],
		['登录 agy', 'antigravity-cli', false],
		['重新登录 antigravity', 'antigravity-cli', false],
		['登录 gemini', 'gemini-cli', false],
		['重新登录 claude 的账号', 'claude-code', false],
	])('%s', (text, harnessId, switchAccount) => {
		const parsed = parseOwnerLoginRequest(text);
		if (harnessId === null) {
			// "登录一下 codex" is not one of the forms; it goes to the orc.
			expect(parsed).toBeNull();
			return;
		}
		expect(parsed).toEqual({ kind: 'harness', harnessId, switchAccount });
	});
});

describe('parseOwnerLoginRequest — English', () => {
	it.each([
		['relogin codex', 'codex-cli', false],
		['re-login claude', 'claude-code', false],
		['login claude', 'claude-code', false],
		['log in to codex', 'codex-cli', false],
		['Please relogin Claude Code.', 'claude-code', false],
		['sign in to claude', 'claude-code', false],
		['claude login', 'claude-code', false],
		['codex relogin', 'codex-cli', false],
		['switch claude account', 'claude-code', true],
		['switch claude to another account', 'claude-code', true],
		['login claude account', 'claude-code', false],
		['relogin agy', 'antigravity-cli', false],
	])('%s', (text, harnessId, switchAccount) => {
		expect(parseOwnerLoginRequest(text)).toEqual({ kind: 'harness', harnessId, switchAccount });
	});
});

describe('parseOwnerLoginRequest — unknown or missing harness', () => {
	it('asks which harness for a bare verb', () => {
		expect(parseOwnerLoginRequest('重新登录')).toEqual({ kind: 'unknown', name: null, switchAccount: false });
		expect(parseOwnerLoginRequest('relogin')).toEqual({ kind: 'unknown', name: null, switchAccount: false });
		expect(parseOwnerLoginRequest('换个账号登录')).toEqual({ kind: 'unknown', name: null, switchAccount: true });
		expect(parseOwnerLoginRequest('重新登录编程助手')).toEqual({ kind: 'unknown', name: null, switchAccount: false });
	});

	it('names another coding assistant as unknown', () => {
		expect(parseOwnerLoginRequest('登录 cursor')).toEqual({ kind: 'unknown', name: 'cursor', switchAccount: false });
		expect(parseOwnerLoginRequest('relogin copilot')).toEqual({ kind: 'unknown', name: 'copilot', switchAccount: false });
	});

	it('leaves other logins and sentences to the orc', () => {
		// A connector, a website, a question, a longer sentence: not ours.
		expect(parseOwnerLoginRequest('登录 gmail')).toBeNull();
		expect(parseOwnerLoginRequest('login google')).toBeNull();
		expect(parseOwnerLoginRequest('claude 登录了吗')).toBeNull();
		expect(parseOwnerLoginRequest('claude 登录过期了吗？')).toBeNull();
		expect(parseOwnerLoginRequest('不 我要重新登陆一个账号')).toBeNull();
		expect(parseOwnerLoginRequest('你不能用claude的command去跑 然后给我登陆链接 我登陆后给你token')).toBeNull();
		expect(parseOwnerLoginRequest('why did the claude login fail yesterday')).toBeNull();
		expect(parseOwnerLoginRequest('hello')).toBeNull();
		expect(parseOwnerLoginRequest('')).toBeNull();
	});

	it('never mistakes an authorization code for a request', () => {
		expect(parseOwnerLoginRequest('0VvdeK5tnWaeMLJkf6qFlX3GXFWbqplxRbX67whkkQBCp59Z#fQCpFhwWR7z-u7Wmz')).toBeNull();
	});

	it('ignores messages over the length cap', () => {
		expect(parseOwnerLoginRequest(`重新登录 claude ${'。'.repeat(80)}`)).toBeNull();
	});
});

describe('isOwnerLoginRequestEvidence', () => {
	it('counts the incident messages for Claude', () => {
		expect(isOwnerLoginRequestEvidence('帮我重新登陆claude code', 'claude-code')).toBe(true);
		expect(isOwnerLoginRequestEvidence('不 我要重新登陆一个账号', 'claude-code')).toBe(true);
		expect(isOwnerLoginRequestEvidence('你不能用claude的command去跑 然后给我登陆链接 我登陆后给你token', 'claude-code')).toBe(true);
		expect(isOwnerLoginRequestEvidence('就直接输入/login 到claude 的 terminal', 'claude-code')).toBe(true);
		expect(isOwnerLoginRequestEvidence('can you log codex in with my other account', 'codex-cli')).toBe(true);
	});

	it('does not count a message about another harness', () => {
		expect(isOwnerLoginRequestEvidence('重新登录 codex', 'claude-code')).toBe(false);
		expect(isOwnerLoginRequestEvidence('please log codex in again', 'claude-code')).toBe(false);
	});

	it('does not count status questions or unrelated messages', () => {
		expect(isOwnerLoginRequestEvidence('claude 登录了吗', 'claude-code')).toBe(false);
		expect(isOwnerLoginRequestEvidence('is claude still logged in?', 'claude-code')).toBe(false);
		expect(isOwnerLoginRequestEvidence('部署一下 CE 站点', 'claude-code')).toBe(false);
		expect(isOwnerLoginRequestEvidence('', 'claude-code')).toBe(false);
	});
});
