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
	let loginState: LoginState = 'logged_in';
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
		expect(describeWaitingAgents([])).toMatch(/No agent/);
		expect(describeWaitingAgents(['a'])).toBe('1 agent is waiting: a.');
		const many = Array.from({ length: 10 }, (_, i) => `a${i}`);
		expect(describeWaitingAgents(many)).toMatch(/10 agents are waiting: a0, .*a7 and 2 more\./);
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
		expect(text).toMatch(/Codex login expired/);
		expect(text).toMatch(/1 agent is waiting: qa-1/);
		expect(lines).toContain(CODEX_URL);
		expect(lines).toContain('WH2P-EO69V');
		expect(text).toMatch(/finish the login on your phone and it continues by itself/i);
	});

	it('Claude: carries the link and asks for the code as a reply', () => {
		const text = formatLinkDm({ ...base, harnessId: 'claude-code', method: 'subscription', userCode: null, url: CLAUDE_URL }, ['crewly-orc']);
		expect(text.split('\n')).toContain(CLAUDE_URL);
		expect(text).toMatch(/Claude Code login expired/);
		expect(text).toMatch(/Reply to this DM with the code/);
	});

	it('unrecognised screen: includes the redacted screen and says the reply is typed in', () => {
		const text = formatScreenDm({ ...base, url: null, userCode: null, screen: `Choose an option\n${TOKEN}\n\`\`\`` }, ['qa-1']);
		expect(text).toMatch(/did not recognise/);
		expect(text).toMatch(/Choose an option/);
		expect(text).toMatch(/typed into that terminal/);
		expect(text).not.toContain(TOKEN);
		// Only the fences the DM itself adds
		expect(text.match(/```/g)).toHaveLength(2);
	});

	it('success, failure and rejection DMs never carry a secret', () => {
		expect(formatSuccessDm('claude-code', { resumed: ['a', 'b'], failed: [] })).toBe('Done: Claude Code is logged in again, 2 agents resumed.');
		expect(formatSuccessDm('codex-cli', { resumed: ['a'], failed: ['b'] })).toMatch(/1 agent resumed\. Could not restart: b\./);
		const failure = formatFailureDm('claude-code', `Login failed ${TOKEN}`);
		expect(failure).toMatch(/relogin/);
		expect(failure).toMatch(/重新登录/);
		expect(failure).not.toContain(TOKEN);
		const rejected = formatRejectedDm({ ...base, method: 'subscription', message: 'Invalid code. Please make sure the full code was copied' });
		expect(rejected).toMatch(/That code did not work \(Invalid code/);
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
		expect(dms[0]).toMatch(/2 agents are waiting: crewly-orc, dev-1/);
	});

	it('after a failure, re-reminds at most once per REMIND_INTERVAL_MS', async () => {
		const { service, broker, dms } = setup();
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		broker.finish('s1', 'timed_out', 'The login was not completed in time.');
		await flush();
		expect(dms).toHaveLength(2);
		expect(dms[1]).toMatch(/did not finish.*relogin/s);
		expect(service.getPending('codex-cli')).toBeNull();

		// Soon after: no new flow, no new DM
		jest.advanceTimersByTime(60_000);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(broker.startCalls).toHaveLength(1);
		expect(dms).toHaveLength(2);

		// After the remind interval: a fresh login and a fresh link
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.REMIND_INTERVAL_MS);
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'screen' });
		await flush();
		expect(broker.startCalls).toHaveLength(2);
		broker.patch('s2', { state: 'awaiting_user', url: CODEX_URL, userCode: 'ABCD-EFGH1' });
		await flush();
		expect(dms).toHaveLength(3);
		expect(dms[2]).toMatch(/ABCD-EFGH1/);
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

	it('passes everything through when no flow exists', () => {
		const { service } = setup();
		expect(service.handleOwnerReply(AUTH_CODE)).toBe(false);
		expect(service.handleOwnerReply('relogin')).toBe(false);
	});

	it('DMs once when the harness rejects the code, and takes the next one', async () => {
		const { service, broker, dms } = await claudeAwaitingCode();
		service.handleOwnerReply(AUTH_CODE);
		const rejected = { state: 'awaiting_user' as const, needsInput: true, message: 'Invalid code. Please make sure the full code was copied' };
		broker.patch('s1', rejected);
		broker.patch('s1', rejected);
		await flush();
		expect(dms).toHaveLength(2);
		expect(dms[1]).toMatch(/That code did not work/);
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
		expect(service.handleOwnerReply('1')).toBe(true);
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
		expect(dms[dms.length - 1]).toBe('Done: Claude Code is logged in again, 2 agents resumed.');
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
		expect(dms[dms.length - 1]).toMatch(/Done: Codex/);
	});

	it('reports agents that could not be restarted', async () => {
		const { service, broker, dms, resumer } = setup();
		resumer.resume.mockResolvedValueOnce({ resumed: [], failed: ['qa-1'] });
		service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(dms[dms.length - 1]).toMatch(/0 agents resumed\. Could not restart: qa-1\./);
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
		expect(dms[1]).toMatch(/Codex login did not finish: device code expired/);

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
		expect(dms[0]).toMatch(/could not start it.*not installed.*relogin/s);
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

	it('reports once it was seen logged in, then logged out', async () => {
		const { service, broker, setLoginState } = setup({ sessionsByHarness: {} });
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
