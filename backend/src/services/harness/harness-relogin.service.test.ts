/**
 * Tests for the harness re-login coordinator (re-login over Slack).
 */

import { EventEmitter } from 'events';
import { HARNESS_CONSTANTS } from '../../constants.js';
import {
	HarnessReloginService,
	describeWaitingAgents,
	formatFailureDm,
	formatLinkDm,
	formatNoBrokerLoginDm,
	formatOwnerSuccessDm,
	formatWhichHarnessDm,
	formatRejectedDm,
	formatScreenDm,
	formatSuccessDm,
	getHarnessReloginService,
	isRetryKeyword,
	looksLikeAuthCode,
	setHarnessReloginServiceForTesting,
	unwrapReply,
	type HarnessReloginDeps,
	type ReloginAgentResumer,
	type ReloginReplyTarget,
} from './harness-relogin.service.js';
import { getHarnessService, setHarnessServiceForTesting } from './harness.service.js';
import type { HarnessId, LoginSession, LoginSessionState, LoginState } from './harness.types.js';
import { LOGIN_BROKER_EVENTS, LoginBrokerError } from './login-broker.service.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

const CLAUDE_URL =
	'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Ainference&code_challenge=abc&state=xyz';
const CODEX_URL = 'https://auth.openai.com/codex/device';
/** A Claude authorization code as shown on platform.claude.com after approving. */
const AUTH_CODE = 'Kq3xZ8vN2mP7rT4wY1bC6dF9gH0jL5nQ#9f8e7d6c5b4a';
/** A long-lived token the broker captures — must never reach a DM or a log. */
const TOKEN = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

/** Minimal broker that behaves like LoginBrokerService's public surface. */
class FakeBroker extends EventEmitter {
	sessions = new Map<string, LoginSession>();
	inputs: Array<{ id: string; text: string }> = [];
	startCalls: Array<{ harnessId: string; method: string }> = [];
	startError: Error | null = null;
	private counter = 0;

	start(harnessId: string, method: string): LoginSession {
		this.startCalls.push({ harnessId, method });
		if (this.startError) throw this.startError;
		for (const s of this.sessions.values()) {
			if (s.harnessId === harnessId && !['succeeded', 'failed', 'timed_out', 'cancelled'].includes(s.state)) return { ...s };
		}
		const id = `s${++this.counter}`;
		const now = new Date().toISOString();
		const session: LoginSession = {
			id,
			harnessId: harnessId as HarnessId,
			method: method as LoginSession['method'],
			state: 'starting',
			url: null,
			userCode: null,
			needsInput: false,
			message: null,
			screen: '',
			startedAt: now,
			updatedAt: now,
		};
		this.sessions.set(id, session);
		return { ...session };
	}

	get(id: string): LoginSession {
		const s = this.sessions.get(id);
		if (!s) throw new LoginBrokerError('not_found', 'nope');
		return { ...s };
	}

	input(id: string, text: string): LoginSession {
		const s = this.get(id);
		if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(s.state)) throw new LoginBrokerError('not_active', 'done');
		this.inputs.push({ id, text });
		return this.patch(id, { state: 'verifying', needsInput: false, message: null });
	}

	cancel(id: string): LoginSession {
		return this.finish(id, 'cancelled', 'Login cancelled.');
	}

	/** Change a session and emit `update`. */
	patch(id: string, patch: Partial<LoginSession>): LoginSession {
		const next = { ...this.get(id), ...patch };
		this.sessions.set(id, next);
		this.emit(LOGIN_BROKER_EVENTS.UPDATE, { ...next });
		return { ...next };
	}

	/** Move a session to a terminal state and emit `update` + `finished`. */
	finish(id: string, state: LoginSessionState, message: string): LoginSession {
		const s = this.patch(id, { state, message, needsInput: false });
		this.emit(LOGIN_BROKER_EVENTS.FINISHED, { ...s });
		return s;
	}
}

/** Harness of fakes around one coordinator. */
function setup(overrides: Partial<HarnessReloginDeps> & { sessionsByHarness?: Record<string, string[]> } = {}) {
	const broker = new FakeBroker();
	const dms: string[] = [];
	const sessionsByHarness = overrides.sessionsByHarness ?? { 'claude-code': ['crewly-orc', 'dev-1'], 'codex-cli': ['qa-1'] };
	const resumer: ReloginAgentResumer & { resume: jest.Mock } = {
		listSessions: (harnessId) => sessionsByHarness[harnessId] ?? [],
		resume: jest.fn(async (names: readonly string[]) => ({ resumed: [...names], failed: [] })),
	};
	const credentials = { read: jest.fn(() => ({})), getClaudeCredentialKind: jest.fn(() => null) };
	const apiKeys = { submit: jest.fn(async () => undefined) };
	let loginState: LoginState = 'logged_out';
	const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
	const service = new HarnessReloginService({
		broker: broker as unknown as HarnessReloginDeps['broker'],
		credentials: credentials as unknown as HarnessReloginDeps['credentials'],
		apiKeys,
		checkLoginState: jest.fn(async () => loginState),
		getOrcHarness: jest.fn(async () => 'codex-cli'),
		notifier: { sendToOwner: jest.fn(async (text: string) => { dms.push(text); return true; }) },
		resumer,
		logger,
		...overrides,
	});
	return {
		service,
		broker,
		dms,
		resumer,
		credentials,
		apiKeys,
		logger,
		setLoginState: (state: LoginState) => {
			loginState = state;
		},
	};
}

/** Let queued promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Everything the coordinator logged, as one string. */
function allLogs(logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }): string {
	return JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
}

beforeEach(() => {
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
});

describe('pure helpers', () => {
	it('recognises the retry keywords', () => {
		expect(isRetryKeyword('relogin')).toBe(true);
		expect(isRetryKeyword('  ReLogin ')).toBe(true);
		expect(isRetryKeyword('重新登录')).toBe(true);
		expect(isRetryKeyword('please relogin')).toBe(false);
	});

	it('unwraps backticks and judges codes by shape', () => {
		expect(unwrapReply(` \`${AUTH_CODE}\` `)).toBe(AUTH_CODE);
		expect(looksLikeAuthCode(AUTH_CODE)).toBe(true);
		expect(looksLikeAuthCode('hello there orc, what are you doing')).toBe(false);
		expect(looksLikeAuthCode('short')).toBe(false);
		expect(looksLikeAuthCode('x'.repeat(HARNESS_CONSTANTS.RELOGIN.CODE_MAX_LENGTH + 1))).toBe(false);
	});

	it('lists waiting agents with a cap', () => {
		expect(describeWaitingAgents([])).toMatch(/没有 agent/);
		expect(describeWaitingAgents(['a'])).toBe('a 在等它。');
		const many = Array.from({ length: 10 }, (_, i) => `a${i}`);
		expect(describeWaitingAgents(many)).toMatch(/a0、.*a7 等 10 个 在等它。/);
	});
});

describe('DM content', () => {
	const base: LoginSession = {
		id: 's1',
		harnessId: 'codex-cli',
		method: 'device',
		state: 'awaiting_user',
		url: CODEX_URL,
		userCode: 'WH2P-EO69V',
		needsInput: false,
		message: null,
		screen: '',
		startedAt: '',
		updatedAt: '',
	};

	it('Codex: names the harness and agents, link and code on their own lines', () => {
		const text = formatLinkDm(base, ['qa-1']);
		const lines = text.split('\n');
		expect(text).toMatch(/Codex 登录过期了/);
		expect(text).toMatch(/qa-1 在等它/);
		expect(lines).toContain(CODEX_URL);
		expect(lines).toContain('WH2P-EO69V');
		expect(text).toMatch(/在手机上完成登录就行，这边会自动继续/);
	});

	it('Claude: carries the link and asks for the code as a reply', () => {
		const text = formatLinkDm({ ...base, harnessId: 'claude-code', method: 'subscription', userCode: null, url: CLAUDE_URL }, ['crewly-orc']);
		expect(text.split('\n')).toContain(CLAUDE_URL);
		expect(text).toMatch(/Claude Code 登录过期了/);
		expect(text).toMatch(/把授权后页面显示的代码直接回复在这里/);
	});

	it('unrecognised screen: includes the redacted screen and says the reply is typed in', () => {
		const text = formatScreenDm({ ...base, url: null, userCode: null, screen: `Choose an option\n${TOKEN}\n\`\`\`` }, ['qa-1']);
		expect(text).toMatch(/没认出它的界面/);
		expect(text).toMatch(/Choose an option/);
		expect(text).toMatch(/输入 <内容>/);
		expect(text).not.toContain(TOKEN);
		// Only the fences the DM itself adds
		expect(text.match(/```/g)).toHaveLength(2);
	});

	it('success, failure and rejection DMs never carry a secret', () => {
		expect(formatSuccessDm('claude-code', { resumed: ['a', 'b'], failed: [] })).toBe('好了：Claude Code 已重新登录，2 个 agent 已恢复。');
		expect(formatSuccessDm('codex-cli', { resumed: ['a'], failed: ['b'] })).toMatch(/1 个 agent 已恢复。 没能重启：b。/);
		const failure = formatFailureDm('claude-code', `Login failed ${TOKEN}`);
		expect(failure).toMatch(/relogin/);
		expect(failure).toMatch(/重新登录/);
		expect(failure).not.toContain(TOKEN);
		const rejected = formatRejectedDm({ ...base, method: 'subscription', message: 'Invalid code. Please make sure the full code was copied' });
		expect(rejected).toMatch(/这个代码没通过（Invalid code/);
	});
});

describe('detection → flow', () => {
	it('starts one Codex device login and DMs the link and code once both are known', async () => {
		const { service, broker, dms } = setup();
		expect(service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' })).toBe(true);
		await flush();
		expect(broker.startCalls).toEqual([{ harnessId: 'codex-cli', method: 'device' }]);

		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL });
		expect(dms).toHaveLength(0);
		broker.patch('s1', { userCode: 'WH2P-EO69V' });
		await flush();
		expect(dms).toHaveLength(1);
		expect(dms[0]).toMatch(/qa-1/);
		expect(dms[0].split('\n')).toContain('WH2P-EO69V');
		expect(service.getPending('codex-cli')).toEqual({ harnessId: 'codex-cli', sessionId: 's1', startedAt: expect.any(String) });
	});

	it('starts Claude with the subscription method', async () => {
		const { service, broker } = setup();
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'output' });
		await flush();
		expect(broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);
	});

	it('returns false for a harness Crewly cannot log in', () => {
		const { service, broker } = setup();
		expect(service.reportExpiry({ harnessId: 'gemini-cli', sessionName: 'g', source: 'output' })).toBe(false);
		expect(broker.startCalls).toHaveLength(0);
	});
});

describe('debounce and reminders', () => {
	it('runs at most one flow per harness; later detections only add stuck agents', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'output' });
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'dev-1', source: 'screen' });
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);
		broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(dms).toHaveLength(1);
		expect(dms[0]).toMatch(/crewly-orc、dev-1 在等它/);
	});

	it('after a failure, re-reminds at most once per REMIND_INTERVAL_MS', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		broker.finish('s1', 'timed_out', 'The login was not completed in time.');
		await flush();
		expect(dms).toHaveLength(2);
		expect(dms[1]).toMatch(/登录没完成.*relogin/s);
		expect(service.getPending('codex-cli')).toBeNull();

		// Soon after: no new flow, no new DM
		jest.advanceTimersByTime(60_000);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);
		expect(dms).toHaveLength(2);

		// After the remind interval: the last link expired unused, so the
		// reminder is text only — no new login (a device code lives 15 min and
		// `codex login` revokes existing credentials when it starts).
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.REMIND_INTERVAL_MS);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'screen' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);
		expect(dms).toHaveLength(3);
		expect(dms[2]).toMatch(/链接已经过期.*qa-1.*重新登录/s);

		// Still at most one reminder per interval.
		jest.advanceTimersByTime(60_000);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'screen' });
		await flush();
		expect(dms).toHaveLength(3);

		// The owner replies when they are there: a fresh login and a fresh link.
		expect(service.handleOwnerReply('重新登录')).toBe(true);
		await flush();
		expect(broker.startCalls).toHaveLength(2);
		broker.patch('s2', { state: 'awaiting_user', url: CODEX_URL, userCode: 'ABCD-EFGH1' });
		await flush();
		expect(dms).toHaveLength(4);
		expect(dms[3]).toMatch(/ABCD-EFGH1/);
	});

	it('a reminder finds the harness logged in again (signed in by hand) and resumes the waiting agents', async () => {
		const { service, broker, dms, resumer, setLoginState } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		broker.finish('s1', 'timed_out', 'The login was not completed in time.');
		await flush();

		setLoginState('logged_in');
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.REMIND_INTERVAL_MS);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'screen' });
		await flush();
		await flush();
		expect(broker.startCalls).toHaveLength(1);
		expect(resumer.resume).toHaveBeenCalledWith(['qa-1']);
		expect(service.getPending('codex-cli')).toBeNull();
		expect(dms[dms.length - 1]).not.toMatch(/链接已经过期/);
	});

	it('a flow that failed (not an expired link) is restarted with a fresh link on the reminder', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.finish('s1', 'failed', 'Error logging in with device code: boom');
		await flush();
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.REMIND_INTERVAL_MS);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'screen' });
		await flush();
		expect(broker.startCalls).toHaveLength(2);
		broker.patch('s2', { state: 'awaiting_user', url: CODEX_URL, userCode: 'ABCD-EFGH1' });
		await flush();
		expect(dms[dms.length - 1]).toMatch(/ABCD-EFGH1/);
	});

	it('does not start a login when the login state is unknown (codex login would revoke a working login)', async () => {
		const { service, broker, setLoginState } = setup();
		setLoginState('unknown');
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(0);
		expect(service.getPending('codex-cli')).toBeNull();
	});

	it('ignores reports right after a successful login (resumed transcripts repeat the old error)', async () => {
		const { service, broker } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);

		// Past the quiet window, a resumed session's screen sweep stays muted
		// until live output reports again.
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.POST_SUCCESS_QUIET_MS + 1);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'screen' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(2);
	});
});

describe('owner reply routing', () => {
	/** A Claude flow whose link was sent and whose prompt waits for the code. */
	async function claudeAwaitingCode() {
		const ctx = setup();
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'output' });
		await flush();
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		return ctx;
	}

	it('types a code-shaped reply into the Claude login and consumes it', async () => {
		const { service, broker, logger } = await claudeAwaitingCode();
		expect(service.handleOwnerReply(`\`${AUTH_CODE}\``)).toBe(true);
		expect(broker.inputs).toEqual([{ id: 's1', text: AUTH_CODE }]);
		expect(allLogs(logger)).not.toContain(AUTH_CODE);
	});

	it('passes a normal message through to the chat path', async () => {
		const { service, broker } = await claudeAwaitingCode();
		expect(service.handleOwnerReply('hey orc, how is the release going?')).toBe(false);
		expect(broker.inputs).toHaveLength(0);
	});

	it('does not take a code while the login is not waiting for input', async () => {
		const { service, broker } = await claudeAwaitingCode();
		broker.patch('s1', { state: 'verifying', needsInput: false });
		expect(service.handleOwnerReply(AUTH_CODE)).toBe(false);
	});

	it('never takes a code for a Codex device login', async () => {
		const { service, broker } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		expect(service.handleOwnerReply(AUTH_CODE)).toBe(false);
		expect(broker.inputs).toHaveLength(0);
	});

	it('passes everything through when no flow exists, except a login request', async () => {
		const { service, dms, broker } = setup();
		expect(service.handleOwnerReply(AUTH_CODE)).toBe(false);
		expect(service.handleOwnerReply('hello orc')).toBe(false);
		// A bare "relogin" with no flow names no harness: asked which one, no login started.
		expect(service.handleOwnerReply('relogin')).toBe(true);
		await flush();
		expect(dms).toEqual([expect.stringMatching(/要登录哪个/)]);
		expect(broker.startCalls).toHaveLength(0);
	});

	it('DMs once when the harness rejects the code, and takes the next one', async () => {
		const { service, broker, dms } = await claudeAwaitingCode();
		service.handleOwnerReply(AUTH_CODE);
		const rejected = { state: 'awaiting_user' as const, needsInput: true, message: 'Invalid code. Please make sure the full code was copied' };
		broker.patch('s1', rejected);
		broker.patch('s1', rejected);
		await flush();
		expect(dms).toHaveLength(2);
		expect(dms[1]).toMatch(/这个代码没通过/);
		expect(service.handleOwnerReply(`${AUTH_CODE}X`)).toBe(true);
		expect(broker.inputs).toHaveLength(2);
	});

	it('keeps a code-shaped reply out of the chat even if the session ended meanwhile', async () => {
		const { service, broker } = await claudeAwaitingCode();
		jest.spyOn(broker, 'input').mockImplementation(() => {
			throw new LoginBrokerError('not_active', 'done');
		});
		expect(service.handleOwnerReply(AUTH_CODE)).toBe(true);
	});

	it('an unrecognised screen: DMs the screen after a while and types the next reply into it', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'output' });
		await flush();
		broker.patch('s1', { screen: 'Select login method:\n❯ 1. Claude account\n  2. Console account' });
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.UNRECOGNISED_SCREEN_MS);
		await flush();
		expect(dms).toHaveLength(1);
		expect(dms[0]).toMatch(/Select login method/);
		// A bare reply is a normal message to the orc, not terminal input.
		expect(service.handleOwnerReply('1')).toBe(false);
		expect(service.handleOwnerReply('输入 1')).toBe(true);
		expect(broker.inputs).toEqual([{ id: 's1', text: '1' }]);
		expect(service.handleOwnerReply('line one\nline two')).toBe(false);
	});

	it('does not send the screen when the link arrived in time', async () => {
		const { service, broker, dms } = await claudeAwaitingCode();
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.UNRECOGNISED_SCREEN_MS * 2);
		await flush();
		expect(dms).toHaveLength(1);
		expect(service.handleOwnerReply('1')).toBe(false);
		expect(broker.inputs).toHaveLength(0);
	});
});

describe('success path', () => {
	it('resumes the stuck agents and DMs "done, N agents resumed" without the token', async () => {
		const { service, broker, dms, resumer } = setup();
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'output' });
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'dev-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		service.handleOwnerReply(AUTH_CODE);
		broker.patch('s1', { screen: `token printed: [redacted]` });
		broker.finish('s1', 'succeeded', 'Logged in. Crewly saved the token for its agents.');
		await flush();
		expect(resumer.resume).toHaveBeenCalledWith(['crewly-orc', 'dev-1']);
		expect(dms[dms.length - 1]).toBe('好了：Claude Code 已重新登录，2 个 agent 已恢复。');
		expect(dms.join('\n')).not.toContain(TOKEN);
		expect(dms.join('\n')).not.toContain(AUTH_CODE);
		expect(service.getPending('claude-code')).toBeNull();
	});

	it('resumes every session of the harness when the stuck ones are unknown (status check)', async () => {
		const { service, broker, resumer, setLoginState } = setup();
		setLoginState('logged_out');
		await service.checkOrcHarness();
		await flush();
		expect(broker.startCalls).toEqual([{ harnessId: 'codex-cli', method: 'device' }]);
		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(resumer.resume).toHaveBeenCalledWith(['qa-1']);
	});

	it('completes the flow when the owner logs in from the web instead', async () => {
		const { service, broker, dms, resumer } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.finish('s1', 'timed_out', 'The login was not completed in time.');
		// The owner then logs in on the Setup page (a new broker session)
		const web = broker.start('codex-cli', 'device');
		broker.finish(web.id, 'succeeded', 'Logged in.');
		await flush();
		expect(resumer.resume).toHaveBeenCalledWith(['qa-1']);
		expect(dms[dms.length - 1]).toMatch(/好了：Codex/);
	});

	it('reports agents that could not be restarted', async () => {
		const { service, broker, dms, resumer } = setup();
		resumer.resume.mockResolvedValueOnce({ resumed: [], failed: ['qa-1'] });
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(dms[dms.length - 1]).toMatch(/0 个 agent 已恢复。 没能重启：qa-1。/);
	});
});

describe('failure path', () => {
	it('DMs once with the retry hint; "relogin" starts over with a new link', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		broker.finish('s1', 'failed', 'device code expired');
		await flush();
		expect(dms).toHaveLength(2);
		expect(dms[1]).toMatch(/Codex 登录没完成：device code expired/);

		expect(service.handleOwnerReply('重新登录')).toBe(true);
		await flush();
		expect(broker.startCalls).toHaveLength(2);
		broker.patch('s2', { state: 'awaiting_user', url: CODEX_URL, userCode: 'NEWC-ODE12' });
		await flush();
		expect(dms[dms.length - 1]).toMatch(/NEWC-ODE12/);
	});

	it('"relogin" during a running flow cancels it quietly and starts a fresh one', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		expect(service.handleOwnerReply('relogin')).toBe(true);
		await flush();
		expect(broker.get('s1').state).toBe('cancelled');
		expect(broker.startCalls).toHaveLength(2);
		expect(dms.filter((dm) => /did not finish/.test(dm))).toHaveLength(0);
	});

	it('DMs a failure when the login cannot even start', async () => {
		const { service, broker, dms } = setup();
		broker.startError = new LoginBrokerError('not_installed', 'Codex is not installed (`codex` not found)');
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(dms).toHaveLength(1);
		expect(dms[0]).toMatch(/没能启动登录.*not installed.*relogin/s);
	});

	it('stays quiet when the session was cancelled elsewhere (web, shutdown)', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.cancel('s1');
		await flush();
		expect(dms).toHaveLength(0);
		expect(service.handleOwnerReply('relogin')).toBe(true);
	});
});

describe('stored API keys', () => {
	it('Claude: a stored Anthropic key resumes the agents silently', async () => {
		const { service, broker, dms, resumer, credentials } = setup();
		credentials.getClaudeCredentialKind.mockReturnValue('api_key' as never);
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'dev-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(0);
		expect(resumer.resume).toHaveBeenCalledWith(['dev-1']);
		expect(dms).toHaveLength(0);
	});

	it('Codex: a stored OpenAI key is re-applied, then the agents resume', async () => {
		const { service, broker, apiKeys, resumer, credentials } = setup();
		credentials.read.mockReturnValue({ codex: { openaiApiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } } as never);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(apiKeys.submit).toHaveBeenCalledWith('codex-cli', 'sk-proj-abcdefghijklmnopqrstuvwxyz');
		expect(broker.startCalls).toHaveLength(0);
		expect(resumer.resume).toHaveBeenCalledWith(['qa-1']);
	});

	it('falls back to the phone login when the key is rejected', async () => {
		const { service, broker, apiKeys, credentials } = setup();
		credentials.read.mockReturnValue({ codex: { openaiApiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } } as never);
		apiKeys.submit.mockRejectedValueOnce(new Error('invalid key'));
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);
	});

	it('falls back to the phone login when the key did not help (expired again soon after)', async () => {
		const { service, broker, credentials } = setup();
		credentials.getClaudeCredentialKind.mockReturnValue('api_key' as never);
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'dev-1', source: 'output' });
		await flush();
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.POST_SUCCESS_QUIET_MS + 1);
		service.reportExpiry({ harnessId: 'claude-code', sessionName: 'dev-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);
	});
});

describe('periodic status check of the orc harness', () => {
	it('does not report a harness that was never logged in and has no agents', async () => {
		const { service, broker, setLoginState } = setup({ sessionsByHarness: {} });
		setLoginState('logged_out');
		await service.checkOrcHarness();
		await flush();
		expect(broker.startCalls).toHaveLength(0);
	});

	it('an agent\'s 401 does not start a login while the harness is still logged in (2026-09-26, Nova)', async () => {
		const { service, broker, setLoginState } = setup();
		setLoginState('logged_in');
		expect(service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'ce-nova', source: 'output' })).toBe(true);
		await flush();
		expect(broker.startCalls).toHaveLength(0);
		// And it stays quiet for a while instead of re-checking every line of output.
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'ce-nova', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(0);
	});

	it('reports once it was seen logged in, then logged out', async () => {
		const { service, broker, setLoginState } = setup({ sessionsByHarness: {} });
		setLoginState('logged_in');
		await service.checkOrcHarness();
		setLoginState('logged_out');
		await service.checkOrcHarness();
		await flush();
		expect(broker.startCalls).toHaveLength(1);
	});

	it('ignores unknown login state and a missing orc harness', async () => {
		const unknown = setup();
		unknown.setLoginState('unknown');
		await unknown.service.checkOrcHarness();
		const none = setup({ getOrcHarness: async () => null });
		none.setLoginState('logged_out');
		await none.service.checkOrcHarness();
		await flush();
		expect(unknown.broker.startCalls).toHaveLength(0);
		expect(none.broker.startCalls).toHaveLength(0);
	});

	it('start() runs the check on an interval; stop() ends it', async () => {
		const { service, broker, setLoginState } = setup();
		setLoginState('logged_out');
		service.start(1000);
		await jest.advanceTimersByTimeAsync(1000);
		expect(broker.startCalls).toHaveLength(1);
		service.stop();
	});
});

/** The thread in the orc's own-bot DM the owner asked in (incident 2026-09-26). */
const ORC_THREAD: ReloginReplyTarget = { channelId: 'D0C381XPD3L', threadTs: '1790450776.351799', agentSession: 'crewly-orc' };

/** A coordinator whose notifier records the reply target of every DM. */
function setupWithTargets(overrides: Partial<HarnessReloginDeps> = {}) {
	const sent: Array<{ text: string; target: ReloginReplyTarget | null | undefined }> = [];
	const ctx = setup({
		notifier: {
			sendToOwner: jest.fn(async (text: string, target?: ReloginReplyTarget | null) => {
				sent.push({ text, target });
				return true;
			}),
			isAvailable: () => true,
		},
		...overrides,
	});
	return { ...ctx, sent };
}

describe('owner-requested login (DM trigger)', () => {
	it('owner DM wording: says what is being logged in, not that it expired', () => {
		const session: LoginSession = {
			id: 's1',
			harnessId: 'claude-code',
			method: 'subscription',
			state: 'awaiting_user',
			url: CLAUDE_URL,
			userCode: null,
			needsInput: true,
			message: null,
			screen: '',
			startedAt: '',
			updatedAt: '',
		};
		const plain = formatLinkDm(session, [], { ownerRequested: true });
		expect(plain.split('\n')[0]).toBe('*登录 Claude Code*');
		expect(plain).not.toMatch(/过期/);
		expect(plain.split('\n')).toContain(CLAUDE_URL);
		const switching = formatLinkDm(session, [], { ownerRequested: true, switchAccount: true });
		expect(switching.split('\n')[0]).toBe('*换账号登录 Claude Code*');
		expect(switching).toMatch(/切到要用的那个账号/);
		expect(formatOwnerSuccessDm('claude-code', { resumed: ['a', 'b'], failed: [] })).toBe('好了：Claude Code 已登录。 2 个 agent 已重启，用上了新登录。');
		expect(formatOwnerSuccessDm('codex-cli', { resumed: [], failed: [] })).toBe('好了：Codex 已登录。');
		expect(formatWhichHarnessDm(null)).toMatch(/^要登录哪个？/);
		expect(formatWhichHarnessDm('cursor')).toMatch(/没有「cursor」/);
		expect(formatNoBrokerLoginDm('antigravity-cli')).toMatch(/Gemini API key/);
		expect(formatNoBrokerLoginDm('gemini-cli')).toMatch(/企业版/);
	});

	it('「重新登录 claude」 starts a forced login even while logged in, answers in the thread, routes the code, reports success once', async () => {
		const { service, broker, sent, resumer, setLoginState } = setupWithTargets();
		setLoginState('logged_in');
		expect(service.handleOwnerReply('重新登录 claude', ORC_THREAD)).toBe(true);
		await flush();
		// Forced: no "still logged in" skip.
		expect(broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);

		broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(sent).toHaveLength(1);
		expect(sent[0].target).toEqual(ORC_THREAD);
		expect(sent[0].text.split('\n')[0]).toBe('*登录 Claude Code*');
		expect(sent[0].text.split('\n')).toContain(CLAUDE_URL);

		// The owner pastes the code in the same thread.
		expect(service.handleOwnerReply(AUTH_CODE, ORC_THREAD)).toBe(true);
		expect(broker.inputs).toEqual([{ id: 's1', text: AUTH_CODE }]);

		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		// Every Claude session restarts onto the new login.
		expect(resumer.resume).toHaveBeenCalledWith(['crewly-orc', 'dev-1']);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({ text: '好了：Claude Code 已登录。 2 个 agent 已重启，用上了新登录。', target: ORC_THREAD });
	});

	it('「换个账号登录 claude」 uses the account-switch wording', async () => {
		const { service, broker, sent } = setupWithTargets();
		expect(service.handleOwnerReply('换个账号登录 claude', ORC_THREAD)).toBe(true);
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(sent[0].text).toMatch(/^\*换账号登录 Claude Code\*/);
	});

	it('skips the silent API key: the owner asked for a link', async () => {
		const { service, broker, credentials, apiKeys } = setupWithTargets();
		credentials.getClaudeCredentialKind.mockReturnValue('api_key' as never);
		credentials.read.mockReturnValue({ codex: { openaiApiKey: 'sk-test' } });
		service.handleOwnerReply('relogin codex', ORC_THREAD);
		service.handleOwnerReply('relogin claude', ORC_THREAD);
		await flush();
		expect(apiKeys.submit).not.toHaveBeenCalled();
		expect(broker.startCalls.map((c) => c.harnessId)).toEqual(['codex-cli', 'claude-code']);
	});

	it('starts a running expiry flow over with a fresh link, without a failure DM for the old one', async () => {
		const { service, broker, sent } = setupWithTargets();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		await flush();
		expect(sent).toHaveLength(1);

		const result = service.startOwnerLogin('codex-cli', { replyTarget: ORC_THREAD, requestedBy: 'orchestrator' });
		expect(result).toEqual({ status: 'restarted', harnessId: 'codex-cli', dmAvailable: true });
		await flush();
		expect(broker.sessions.get('s1')?.state).toBe('cancelled');
		expect(broker.startCalls).toHaveLength(2);
		broker.patch('s2', { state: 'awaiting_user', url: CODEX_URL, userCode: 'AB12-CD34' });
		await flush();
		expect(sent).toHaveLength(2);
		expect(sent[1].target).toEqual(ORC_THREAD);
		expect(sent[1].text).toMatch(/^\*登录 Codex\*/);
		// The stuck agent from the expiry is still the one resumed.
		broker.finish('s2', 'succeeded', 'Logged in.');
		await flush();
		expect(sent[2].text).toBe('好了：Codex 已登录。 1 个 agent 已重启，用上了新登录。');
	});

	it('is not swallowed by the quiet period right after a login', async () => {
		const { service, broker } = setupWithTargets();
		service.handleOwnerReply('登录 codex', ORC_THREAD);
		await flush();
		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(service.handleOwnerReply('换个账号登录 codex', ORC_THREAD)).toBe(true);
		await flush();
		expect(broker.startCalls).toHaveLength(2);
	});

	it('a failed owner flow, retried with 「重新登录」, keeps its wording and thread', async () => {
		const { service, broker, sent } = setupWithTargets();
		service.handleOwnerReply('换个账号登录 claude', ORC_THREAD);
		await flush();
		broker.finish('s1', 'timed_out', 'Login timed out.');
		await flush();
		expect(sent[0]).toEqual({ text: expect.stringMatching(/Claude Code 登录没完成/), target: ORC_THREAD });
		expect(service.handleOwnerReply('重新登录', ORC_THREAD)).toBe(true);
		await flush();
		broker.patch('s2', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(sent[1].target).toEqual(ORC_THREAD);
		expect(sent[1].text).toMatch(/^\*换账号登录 Claude Code\*/);
	});

	it('asks which harness for an unknown one, and explains harnesses without a link login', async () => {
		const { service, broker, sent } = setupWithTargets();
		expect(service.handleOwnerReply('登录 cursor', ORC_THREAD)).toBe(true);
		expect(service.handleOwnerReply('登录 agy', ORC_THREAD)).toBe(true);
		expect(service.handleOwnerReply('relogin gemini', ORC_THREAD)).toBe(true);
		await flush();
		expect(broker.startCalls).toHaveLength(0);
		expect(sent.map((m) => m.target)).toEqual([ORC_THREAD, ORC_THREAD, ORC_THREAD]);
		expect(sent[0].text).toMatch(/没有「cursor」/);
		expect(sent[1].text).toMatch(/Gemini API key/);
		expect(sent[2].text).toMatch(/企业版/);
		expect(service.startOwnerLogin('antigravity-cli', { requestedBy: 'orchestrator' })).toEqual({
			status: 'no_broker_login',
			harnessId: 'antigravity-cli',
			message: formatNoBrokerLoginDm('antigravity-cli'),
		});
	});

	it('leaves ordinary messages about logins to the orc', () => {
		const { service, broker } = setupWithTargets();
		expect(service.handleOwnerReply('claude 登录了吗', ORC_THREAD)).toBe(false);
		expect(service.handleOwnerReply('不 我要重新登陆一个账号', ORC_THREAD)).toBe(false);
		expect(broker.startCalls).toHaveLength(0);
	});

	it('reports dmAvailable=false when there is no way to reach the owner', () => {
		const { service } = setup({ notifier: null });
		expect(service.startOwnerLogin('claude-code', { requestedBy: 'orchestrator' })).toEqual({
			status: 'started',
			harnessId: 'claude-code',
			dmAvailable: false,
		});
	});
});

describe('no notifier / no resumer', () => {
	it('still runs the flow and logs that no DM path exists', async () => {
		const { service, broker, logger } = setup({ notifier: null, resumer: null });
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		await flush();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no Slack DM path/), expect.anything());
		service.setNotifier({ sendToOwner: async () => false });
		service.setResumer(null);
		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/not delivered/), expect.anything());
	});
});

describe('backend singleton', () => {
	afterEach(() => {
		setHarnessReloginServiceForTesting(null);
		setHarnessServiceForTesting(null);
	});

	it('is bound to the harness service and feeds reloginPending into its overview', () => {
		const service = getHarnessReloginService();
		expect(getHarnessReloginService()).toBe(service);
		const spy = jest.spyOn(service, 'getPending').mockReturnValue({ harnessId: 'codex-cli', sessionId: 'x', startedAt: 't' });
		expect(getHarnessService().getReloginPending('codex-cli')).toEqual({ harnessId: 'codex-cli', sessionId: 'x', startedAt: 't' });
		spy.mockRestore();
	});
});
