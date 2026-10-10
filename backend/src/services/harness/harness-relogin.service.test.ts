/**
 * Tests for the harness re-login coordinator (agent-free re-login from the
 * owner's phone).
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
	formatRejectedDm,
	formatScreenDm,
	formatSignedOutDm,
	formatSuccessDm,
	formatWhichHarnessDm,
	getHarnessReloginService,
	isLoginKeyword,
	isRetryKeyword,
	looksLikeAuthCode,
	setHarnessReloginServiceForTesting,
	unwrapReply,
	type ConfiguredAgent,
	type HarnessReloginDeps,
	type ReloginAgentResumer,
	type ReloginReplyTarget,
} from './harness-relogin.service.js';
import { getHarnessService, setHarnessServiceForTesting } from './harness.service.js';
import type { HarnessId, LoginSession, LoginSessionState, LoginState } from './harness.types.js';
import { LOGIN_BROKER_EVENTS, LoginBrokerError } from './login-broker.service.js';
import { MemoryReloginStateStore } from './relogin-state.store.js';

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
const MACHINE = 'iriss-air.lan';
/** The owner's DM with this machine's own orc bot, where notices land. */
const ORC_DM: ReloginReplyTarget = { channelId: 'DORCAIR', agentSession: 'crewly-orc' };
/** The thread in the orc's own-bot DM the owner asked in (incident 2026-09-26). */
const ORC_THREAD: ReloginReplyTarget = { channelId: 'D0C381XPD3L', threadTs: '1790450776.351799', agentSession: 'crewly-orc' };
/** The owner's DM with Ella's own bot. */
const ELLA_DM: ReloginReplyTarget = { channelId: 'DELLA', threadTs: '1.0', agentSession: 'ella-1' };
const HOUR = 60 * 60 * 1000;
const CJK = /[一-鿿]/;

/** Minimal broker that behaves like LoginBrokerService's public surface. */
class FakeBroker extends EventEmitter {
	sessions = new Map<string, LoginSession>();
	inputs: Array<{ id: string; text: string }> = [];
	startCalls: Array<{ harnessId: string; method: string; account?: string }> = [];
	startError: Error | null = null;
	private counter = 0;

	start(harnessId: string, method: string, options: { account?: string } = {}): LoginSession {
		this.startCalls.push({ harnessId, method, ...(options.account ? { account: options.account } : {}) });
		if (this.startError) throw this.startError;
		for (const s of this.sessions.values()) {
			if (s.harnessId === harnessId && s.account === options.account && !['succeeded', 'failed', 'timed_out', 'cancelled'].includes(s.state)) return { ...s };
		}
		const id = `s${++this.counter}`;
		const now = new Date().toISOString();
		const session: LoginSession = {
			id,
			harnessId: harnessId as HarnessId,
			...(options.account ? { account: options.account } : {}),
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

/** Options of {@link setup}. */
type SetupOptions = Partial<HarnessReloginDeps> & {
	/** Live sessions per harness */
	sessionsByHarness?: Record<string, string[]>;
	/** Configured agents (running or not) */
	agents?: ConfiguredAgent[];
};

/** The Air: every agent and the orc run Claude Code. */
const AIR_AGENTS: ConfiguredAgent[] = [
	{ sessionName: 'crewly-orc', harnessId: 'claude-code', displayName: 'Crewly Orc' },
	{ sessionName: 'ella-1', harnessId: 'claude-code', displayName: 'Ella' },
	{ sessionName: 'qa-1', harnessId: 'codex-cli', displayName: 'Quinn' },
];

/** Harness of fakes around one coordinator. */
function setup(overrides: SetupOptions = {}) {
	const broker = new FakeBroker();
	const sent: Array<{ text: string; target: ReloginReplyTarget | null | undefined }> = [];
	const dms: string[] = [];
	const sessionsByHarness = overrides.sessionsByHarness ?? { 'claude-code': ['crewly-orc', 'ella-1'], 'codex-cli': ['qa-1'] };
	const resumer: ReloginAgentResumer & { resume: jest.Mock } = {
		listSessions: (harnessId) => sessionsByHarness[harnessId] ?? [],
		resume: jest.fn(async (names: readonly string[]) => ({ resumed: [...names], failed: [] })),
	};
	const credentials = { read: jest.fn(() => ({})), getClaudeCredentialKind: jest.fn(() => null) };
	const apiKeys = { submit: jest.fn(async () => undefined) };
	// The Air: the stored credential is still there (status says logged in),
	// the live probe finds it expired.
	// Codex is fine unless a test says otherwise.
	const login: { status: LoginState; probe: LoginState; codexStatus: LoginState; codexProbe: LoginState } = {
		status: 'logged_in',
		probe: 'logged_out',
		codexStatus: 'logged_in',
		codexProbe: 'logged_in',
	};
	const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
	const state = overrides.state ?? new MemoryReloginStateStore();
	const onLoginRestored = jest.fn(async (_harnessId: HarnessId, _resumed: readonly string[]) => 3);
	const verifyLogin = jest.fn(async (harnessId: HarnessId) => (harnessId === 'codex-cli' ? login.codexProbe : login.probe));
	const service = new HarnessReloginService({
		broker: broker as unknown as HarnessReloginDeps['broker'],
		credentials: credentials as unknown as HarnessReloginDeps['credentials'],
		apiKeys,
		checkLoginState: jest.fn(async (harnessId: HarnessId) => (harnessId === 'codex-cli' ? login.codexStatus : login.status)),
		verifyLogin,
		getOrcHarness: jest.fn(async () => 'claude-code'),
		listAgents: async () => overrides.agents ?? AIR_AGENTS,
		machineName: () => MACHINE,
		state,
		onLoginRestored,
		notifier: {
			sendToOwner: jest.fn(async (text: string, target?: ReloginReplyTarget | null) => {
				sent.push({ text, target });
				dms.push(text);
				return target ?? ORC_DM;
			}),
			isAvailable: () => true,
		},
		resumer,
		logger,
		...overrides,
	});
	return { service, broker, sent, dms, resumer, credentials, apiKeys, logger, state, login, onLoginRestored, verifyLogin };
}

/** Let queued promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Everything the coordinator logged, as one string. */
function allLogs(logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }): string {
	return JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
}

/**
 * Detect + confirm a Claude expiry and load the configured agents.
 *
 * @param ctx - Coordinator fakes
 */
async function signOutClaude(ctx: ReturnType<typeof setup>): Promise<void> {
	await ctx.service.checkHarnesses();
	await flush();
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

	it('recognises bare login keywords in English and Chinese', () => {
		for (const t of ['login', 'Login!', 'log in', 'sign in', '`login`', 'relogin', '重新登录', '登录', '重新登陆。']) expect(isLoginKeyword(t)).toBe(true);
		for (const t of ['login to gmail', 'can you log in', 'logins', '', 'hello']) expect(isLoginKeyword(t)).toBe(false);
	});

	it('unwraps backticks and judges codes by shape', () => {
		expect(unwrapReply(` \`${AUTH_CODE}\` `)).toBe(AUTH_CODE);
		expect(looksLikeAuthCode(AUTH_CODE)).toBe(true);
		expect(looksLikeAuthCode('hello there orc, what are you doing')).toBe(false);
		expect(looksLikeAuthCode('short')).toBe(false);
		expect(looksLikeAuthCode('x'.repeat(HARNESS_CONSTANTS.RELOGIN.CODE_MAX_LENGTH + 1))).toBe(false);
	});

	it('lists waiting agents with a cap', () => {
		expect(describeWaitingAgents([])).toBe('');
		expect(describeWaitingAgents(['Ella'])).toBe('Ella');
		const many = Array.from({ length: 10 }, (_, i) => `a${i}`);
		expect(describeWaitingAgents(many)).toBe('a0, a1, a2, a3, a4, a5, a6, a7 and 2 more');
	});
});

describe('DM content (English; the harness writes it)', () => {
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

	it('signed-out notice names the runtime, the machine, how many agents, and the one-word reply', () => {
		expect(formatSignedOutDm('claude-code', MACHINE, ['Crewly Orc', 'Ella'])).toBe(
			"*Claude Code on iriss-air.lan is signed out*, so 2 agents can't work (Crewly Orc, Ella).\nReply `login` here to sign in from your phone (or `relogin claude`).",
		);
		expect(formatSignedOutDm('codex-cli', MACHINE, [], 'reminder')).toBe(
			'Reminder: Codex on iriss-air.lan is still signed out.\nReply `login` here to sign in from your phone (or `relogin codex`).',
		);
		expect(formatSignedOutDm('claude-code', MACHINE, ['Ella'], 'link_expired')).toMatch(/link for Claude Code on iriss-air.lan expired.*1 agent still waiting.*Reply `login`/);
	});

	it('Codex: link and code on their own lines', () => {
		const text = formatLinkDm(base, [], { machine: MACHINE });
		const lines = text.split('\n');
		expect(lines[0]).toBe('*Sign in to Codex on iriss-air.lan*');
		expect(lines).toContain(CODEX_URL);
		expect(lines).toContain('WH2P-EO69V');
		expect(text).toMatch(/Crewly continues by itself/);
	});

	it('Claude: carries the link and asks for the code as a reply', () => {
		const text = formatLinkDm({ ...base, harnessId: 'claude-code', method: 'subscription', userCode: null, url: CLAUDE_URL }, [], { machine: MACHINE });
		expect(text.split('\n')[0]).toBe('*Sign in to Claude Code on iriss-air.lan*');
		expect(text.split('\n')).toContain(CLAUDE_URL);
		expect(text).toMatch(/Reply here with the code the page shows/);
		const switching = formatLinkDm({ ...base, harnessId: 'claude-code', method: 'subscription', userCode: null, url: CLAUDE_URL }, [], { switchAccount: true });
		expect(switching.split('\n')[0]).toBe('*Switch the Claude Code account*');
		expect(switching).toMatch(/switch to it on that page/);
	});

	it('unrecognised screen: includes the redacted screen and says how to type into it', () => {
		const text = formatScreenDm({ ...base, url: null, userCode: null, screen: `Choose an option\n${TOKEN}\n\`\`\`` });
		expect(text).toMatch(/doesn't recognise its screen/);
		expect(text).toMatch(/Choose an option/);
		expect(text).toMatch(/`input <text>`/);
		expect(text).not.toContain(TOKEN);
		expect(text.match(/```/g)).toHaveLength(2);
	});

	it('success, failure and rejection DMs never carry a secret', () => {
		expect(formatSuccessDm('claude-code', { resumed: ['a', 'b'], failed: [] }, 3, MACHINE)).toBe(
			'Done: Claude Code on iriss-air.lan is signed in again. 2 agents resumed; 3 waiting messages re-delivered.',
		);
		expect(formatSuccessDm('codex-cli', { resumed: ['a'], failed: ['b'] })).toBe('Done: Codex is signed in again. 1 agent resumed. Could not restart: b.');
		const failure = formatFailureDm('claude-code', `Login failed ${TOKEN}`);
		expect(failure).toMatch(/^Signing in to Claude Code didn't finish: Login failed \[redacted\]\. Reply `login` to try again\.$/);
		expect(failure).not.toContain(TOKEN);
		const rejected = formatRejectedDm({ ...base, method: 'subscription', message: 'Invalid code. Please make sure the full code was copied' });
		expect(rejected).toMatch(/^That code didn't work \(Invalid code/);
		expect(formatOwnerSuccessDm('claude-code', { resumed: ['a', 'b'], failed: [] }, 1)).toBe('Done: Claude Code is signed in. 2 agents restarted on the new login; 1 waiting message re-delivered.');
		expect(formatOwnerSuccessDm('codex-cli', { resumed: [], failed: [] })).toBe('Done: Codex is signed in.');
	});

	it('no Chinese in anything the harness writes to the owner', () => {
		const texts = [
			formatSignedOutDm('claude-code', MACHINE, ['Ella']),
			formatSignedOutDm('claude-code', MACHINE, ['Ella'], 'reminder'),
			formatSignedOutDm('claude-code', MACHINE, ['Ella'], 'link_expired'),
			formatLinkDm(base),
			formatLinkDm({ ...base, method: 'subscription', url: CLAUDE_URL }, [], { switchAccount: true }),
			formatScreenDm({ ...base, screen: 'x' }),
			formatRejectedDm(base),
			formatSuccessDm('claude-code', { resumed: ['a'], failed: ['b'] }, 2),
			formatOwnerSuccessDm('claude-code', { resumed: ['a'], failed: ['b'] }, 2),
			formatFailureDm('codex-cli', 'x'),
			formatWhichHarnessDm(null),
			formatWhichHarnessDm('cursor'),
			formatNoBrokerLoginDm('antigravity-cli'),
			formatNoBrokerLoginDm('gemini-cli'),
		];
		for (const text of texts) expect(text).not.toMatch(CJK);
	});
});

describe('detection with no agent able to run (the Air, 2026-09-30)', () => {
	it('a stored-but-expired Claude login is confirmed by the live probe and the owner gets ONE notice, no link yet', async () => {
		const ctx = setup();
		expect(ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'crewly-orc', source: 'screen' })).toBe(true);
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'screen' });
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.verifyLogin).toHaveBeenCalledWith('claude-code');
		expect(ctx.broker.startCalls).toHaveLength(0);
		expect(ctx.sent).toHaveLength(1);
		expect(ctx.sent[0].text).toBe(
			"*Claude Code on iriss-air.lan is signed out*, so 2 agents can't work (Crewly Orc, Ella).\nReply `login` here to sign in from your phone (or `relogin claude`).",
		);
		// Default destination: this machine's own DM (the notifier decides — orc bot first).
		expect(ctx.sent[0].target).toBeNull();
		expect(ctx.service.isSignedOut('claude-code')).toBe(true);
		expect(ctx.service.signedOutHarnessOf('ella-1')).toBe('claude-code');
		expect(ctx.service.signedOutHarnessOf('qa-1')).toBeNull();
	});

	it('zero agents running: the periodic check probes every harness in use and notices the expiry', async () => {
		const ctx = setup({ sessionsByHarness: {} });
		await signOutClaude(ctx);
		expect(ctx.sent).toHaveLength(1);
		expect(ctx.sent[0].text).toMatch(/Claude Code on iriss-air.lan is signed out/);
		// Codex (qa-1) is in use too and was probed, but it is fine.
		expect(ctx.verifyLogin).toHaveBeenCalledWith('codex-cli');
	});

	it('the probe is not run again within PROBE_INTERVAL_MS while the harness is fine', async () => {
		const ctx = setup({ sessionsByHarness: {} });
		ctx.login.probe = 'logged_in';
		await ctx.service.checkHarnesses();
		await ctx.service.checkHarnesses();
		expect(ctx.verifyLogin.mock.calls.filter(([h]) => h === 'claude-code')).toHaveLength(1);
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.PROBE_INTERVAL_MS);
		await ctx.service.checkHarnesses();
		expect(ctx.verifyLogin.mock.calls.filter(([h]) => h === 'claude-code')).toHaveLength(2);
		expect(ctx.sent).toHaveLength(0);
	});

	it('a status that says logged_out (no credential at all) needs no probe', async () => {
		const ctx = setup({ sessionsByHarness: {}, verifyLogin: undefined });
		ctx.login.status = 'logged_out';
		await signOutClaude(ctx);
		expect(ctx.sent.map((m) => m.text).join('\n')).toMatch(/Claude Code on iriss-air.lan is signed out/);
	});

	it('does not report a harness that was never logged in and nobody uses', async () => {
		const ctx = setup({ sessionsByHarness: {}, agents: [], getOrcHarness: async () => null });
		ctx.login.status = 'logged_out';
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.sent).toHaveLength(0);
	});

	it("an agent's 401 does not alert while the probe says the login works (2026-09-26, Nova)", async () => {
		const ctx = setup();
		ctx.login.probe = 'logged_in';
		expect(ctx.service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'ce-nova', source: 'output' })).toBe(true);
		await flush();
		expect(ctx.sent).toHaveLength(0);
		expect(ctx.broker.startCalls).toHaveLength(0);
		// Quiet for a while instead of re-checking every line of output.
		ctx.service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'ce-nova', source: 'output' });
		await flush();
		expect(ctx.verifyLogin).toHaveBeenCalledTimes(1);
	});

	it('an unknown probe (network down) with a stored credential is not proof: no alert', async () => {
		const ctx = setup();
		ctx.login.probe = 'unknown';
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'output' });
		await flush();
		expect(ctx.sent).toHaveLength(0);
	});

	it('returns false for a harness Crewly cannot log in', () => {
		const ctx = setup();
		expect(ctx.service.reportExpiry({ harnessId: 'gemini-cli', sessionName: 'g', source: 'output' })).toBe(false);
	});
});

describe('backoff', () => {
	it('one notice, then re-reminders at 3 h, 6 h, 12 h … (re-verified each time)', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		expect(ctx.sent).toHaveLength(1);

		// Reports and periodic checks within the backoff: silent.
		for (let i = 0; i < 5; i++) {
			jest.advanceTimersByTime(30 * 60 * 1000);
			ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'screen' });
			await ctx.service.checkHarnesses();
			await flush();
		}
		expect(ctx.sent).toHaveLength(1);

		jest.advanceTimersByTime(30 * 60 * 1000); // 3 h after the notice
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.sent).toHaveLength(2);
		expect(ctx.sent[1].text).toMatch(/^Reminder: Claude Code on iriss-air.lan is still signed out/);

		jest.advanceTimersByTime(3 * HOUR);
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.sent).toHaveLength(2);
		jest.advanceTimersByTime(3 * HOUR); // 6 h after the reminder
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.sent).toHaveLength(3);
		expect(ctx.state.get('claude-code').noticeCount).toBe(3);
	});

	it('survives a backend restart: no second notice inside the backoff, a reminder after it', async () => {
		const state = new MemoryReloginStateStore();
		const first = setup({ state });
		await signOutClaude(first);
		expect(first.sent).toHaveLength(1);
		first.service.stop();

		const second = setup({ state });
		await signOutClaude(second);
		expect(second.sent).toHaveLength(0);
		jest.advanceTimersByTime(3 * HOUR);
		await second.service.checkHarnesses();
		await flush();
		expect(second.sent).toHaveLength(1);
		expect(second.sent[0].text).toMatch(/^Reminder:/);
	});

	it('a reminder finds the harness signed in again (done on the machine) and resumes the waiting agents instead', async () => {
		const ctx = setup();
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'screen' });
		await flush();
		ctx.login.probe = 'logged_in';
		jest.advanceTimersByTime(3 * HOUR);
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.broker.startCalls).toHaveLength(0);
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['ella-1', 'crewly-orc']);
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/^Done: Claude Code on iriss-air.lan is signed in again\. 2 agents resumed; 3 waiting messages re-delivered\.$/);
		expect(ctx.service.isSignedOut('claude-code')).toBe(false);
	});
});

describe('owner replies `login` → link → code → agents back (Claude)', () => {
	it('starts the broker with no agent involved, relays the link to the DM the owner wrote in, types the code, confirms, resumes and re-delivers', async () => {
		const ctx = setup({ sessionsByHarness: { 'claude-code': [] } });
		await signOutClaude(ctx);
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'screen' });

		expect(ctx.service.handleOwnerReply('login', ORC_DM)).toBe(true);
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);
		expect(ctx.service.getPending('claude-code')).toEqual({ harnessId: 'claude-code', sessionId: 's1', startedAt: expect.any(String) });

		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		const link = ctx.sent[ctx.sent.length - 1];
		expect(link.target).toEqual(ORC_DM);
		expect(link.text.split('\n')[0]).toBe('*Sign in to Claude Code on iriss-air.lan*');
		expect(link.text.split('\n')).toContain(CLAUDE_URL);

		// A code-shaped message in another DM is not the code.
		expect(ctx.service.handleOwnerReply(AUTH_CODE, ELLA_DM, 'agent')).toBe(false);
		expect(ctx.broker.inputs).toHaveLength(0);
		// The code, in the DM the link went to.
		expect(ctx.service.handleOwnerReply(`\`${AUTH_CODE}\``, ORC_DM)).toBe(true);
		expect(ctx.broker.inputs).toEqual([{ id: 's1', text: AUTH_CODE }]);

		ctx.login.probe = 'logged_in';
		ctx.broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.verifyLogin).toHaveBeenLastCalledWith('claude-code');
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['ella-1']);
		expect(ctx.onLoginRestored).toHaveBeenCalledWith('claude-code', ['ella-1']);
		expect(ctx.sent[ctx.sent.length - 1]).toEqual({
			text: 'Done: Claude Code on iriss-air.lan is signed in again. 1 agent resumed; 3 waiting messages re-delivered.',
			target: ORC_DM,
		});
		expect(ctx.service.isSignedOut('claude-code')).toBe(false);
		expect(ctx.service.getPending('claude-code')).toBeNull();
		// The code never reaches a log.
		expect(allLogs(ctx.logger)).not.toContain(AUTH_CODE);
	});

	it('accepts the Chinese aliases as the reply', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		expect(ctx.service.handleOwnerReply('重新登录', ORC_DM)).toBe(true);
		expect(ctx.broker.startCalls).toHaveLength(1);
	});

	it('`login` in an agent\'s own DM (the watchdog note) signs in that agent\'s harness', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		expect(ctx.service.handleOwnerReply('login', ELLA_DM, 'agent')).toBe(true);
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].target).toEqual(ELLA_DM);
	});

	it('in an agent\'s DM only login replies are taken; everything else is that agent\'s mail', async () => {
		const ctx = setup();
		expect(ctx.service.handleOwnerReply('login', ELLA_DM, 'agent')).toBe(false);
		expect(ctx.service.handleOwnerReply('hello Ella', ELLA_DM, 'agent')).toBe(false);
		expect(ctx.service.handleOwnerReply('登录 cursor', ELLA_DM, 'agent')).toBe(false);
		expect(ctx.service.handleOwnerReply('relogin codex', ELLA_DM, 'agent')).toBe(true);
	});

	it('`login` in an agent DM also works when only the monitor flagged the agent (not yet confirmed)', async () => {
		const ctx = setup({ sessionNeedsLogin: (s) => s === 'ella-1' });
		await ctx.service.checkHarnesses().catch(() => undefined);
		ctx.login.probe = 'unknown';
		await flush();
		expect(ctx.service.handleOwnerReply('login', ELLA_DM, 'agent')).toBe(true);
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);
	});

	it('a wrong code is reported once; the next code is taken', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		const before = ctx.sent.length;
		ctx.service.handleOwnerReply(AUTH_CODE, ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', needsInput: true, message: 'Invalid code. Please make sure the full code was copied' });
		ctx.broker.patch('s1', { state: 'awaiting_user', needsInput: true, message: 'Invalid code. Please make sure the full code was copied' });
		await flush();
		expect(ctx.sent).toHaveLength(before + 1);
		expect(ctx.sent[before].text).toMatch(/^That code didn't work \(Invalid code/);
		expect(ctx.service.handleOwnerReply(`${AUTH_CODE}X`, ORC_DM)).toBe(true);
		expect(ctx.broker.inputs).toHaveLength(2);
	});

	it('an expired link puts the flow back to "signed out"; `login` gets a fresh link', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		ctx.broker.finish('s1', 'timed_out', 'The login was not completed in time.');
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/^The sign-in link for Claude Code on iriss-air.lan expired before it was used.*Reply `login`/);
		expect(ctx.service.getPending('claude-code')).toBeNull();
		// A late code for the dead session is not typed anywhere — it goes on as chat.
		expect(ctx.service.handleOwnerReply(AUTH_CODE, ORC_DM)).toBe(false);
		expect(ctx.service.handleOwnerReply('login', ORC_DM)).toBe(true);
		expect(ctx.broker.startCalls).toHaveLength(2);
	});

	it('a failed sign-in DMs the reason once (redacted) with the retry hint', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.finish('s1', 'failed', `OAuth error ${TOKEN}`);
		await flush();
		const last = ctx.sent[ctx.sent.length - 1].text;
		expect(last).toBe("Signing in to Claude Code didn't finish: OAuth error [redacted]. Reply `login` to try again.");
	});

	it('the sign-in finished but the probe still fails: says so, stays signed out', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.resumer.resume).not.toHaveBeenCalled();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/didn't finish: the sign-in finished, but it still does not work/);
		expect(ctx.service.isSignedOut('claude-code')).toBe(true);
	});

	it('`login` during a running sign-in cancels it quietly and sends a fresh link', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		const before = ctx.sent.length;
		ctx.service.handleOwnerReply('relogin', ORC_DM);
		await flush();
		expect(ctx.broker.sessions.get('s1')?.state).toBe('cancelled');
		expect(ctx.broker.startCalls).toHaveLength(2);
		expect(ctx.sent).toHaveLength(before); // no failure DM for the cancelled one
	});

	it('DMs a failure when the login cannot even start', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.broker.startError = new LoginBrokerError('not_installed', 'claude is not installed');
		ctx.service.handleOwnerReply('login', ORC_DM);
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/Crewly could not start the sign-in \(claude is not installed\)/);
	});

	it('an unrecognised screen: DMs the screen after a while and types an `input …` reply into it', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', screen: 'Select: 1) A 2) B' });
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.UNRECOGNISED_SCREEN_MS + 1);
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/Select: 1\) A 2\) B/);
		expect(ctx.service.handleOwnerReply('hello orc', ORC_DM)).toBe(false);
		expect(ctx.service.handleOwnerReply('input 1', ORC_DM)).toBe(true);
		expect(ctx.broker.inputs).toEqual([{ id: 's1', text: '1' }]);
	});

	it('passes normal messages through while a code is awaited', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(ctx.service.handleOwnerReply('what is the weather like', ORC_DM)).toBe(false);
	});
});

describe('Codex variant', () => {
	const CODEX_ONLY: ConfiguredAgent[] = [
		{ sessionName: 'crewly-orc', harnessId: 'codex-cli', displayName: 'Crewly Orc' },
		{ sessionName: 'nova-1', harnessId: 'codex-cli', displayName: 'Nova' },
	];

	it('signed out → notice; `login` → device link + code; success needs no code reply; agents resume', async () => {
		const ctx = setup({ agents: CODEX_ONLY, getOrcHarness: async () => 'codex-cli', sessionsByHarness: { 'codex-cli': ['nova-1'] } });
		ctx.login.codexStatus = 'logged_out';
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.sent[0].text).toMatch(/^\*Codex on iriss-air.lan is signed out\*, so 2 agents can't work \(Crewly Orc, Nova\)/);
		// `codex login` revokes credentials when it starts: never started without the owner.
		expect(ctx.broker.startCalls).toHaveLength(0);

		ctx.service.handleOwnerReply('login', ORC_DM);
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'codex-cli', method: 'device' }]);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL });
		await flush();
		expect(ctx.sent).toHaveLength(1); // waits for the code too
		ctx.broker.patch('s1', { userCode: 'WH2P-EO69V' });
		await flush();
		expect(ctx.sent[1].text.split('\n')).toEqual(expect.arrayContaining([CODEX_URL, 'WH2P-EO69V']));
		// A code-shaped reply is never typed into a device login.
		expect(ctx.service.handleOwnerReply(AUTH_CODE, ORC_DM)).toBe(false);

		ctx.login.codexStatus = 'logged_in';
		ctx.broker.finish('s1', 'succeeded', 'Successfully logged in');
		await flush();
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['nova-1']);
		expect(ctx.onLoginRestored).toHaveBeenCalledWith('codex-cli', ['nova-1']);
		expect(ctx.sent[2].text).toBe('Done: Codex on iriss-air.lan is signed in again. 1 agent resumed; 3 waiting messages re-delivered.');
	});

	it('an expired device code becomes a reminder to reply `login` (no new code while nobody is there)', async () => {
		const ctx = setup({ agents: CODEX_ONLY, getOrcHarness: async () => 'codex-cli' });
		ctx.login.codexStatus = 'logged_out';
		await ctx.service.checkHarnesses();
		await flush();
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		ctx.broker.finish('s1', 'timed_out', 'Device code expired.');
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/^The sign-in link for Codex/);
		jest.advanceTimersByTime(4 * HOUR);
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.broker.startCalls).toHaveLength(1);
	});
});

describe('stored API keys', () => {
	it('Claude: a stored Anthropic key resumes the agents silently', async () => {
		const ctx = setup();
		ctx.credentials.getClaudeCredentialKind.mockReturnValue('api_key' as never);
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'output' });
		await flush();
		expect(ctx.broker.startCalls).toHaveLength(0);
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['ella-1', 'crewly-orc']);
		expect(ctx.sent).toHaveLength(0);
	});

	it('Codex: a stored OpenAI key is re-applied, then the agents resume', async () => {
		const ctx = setup();
		ctx.credentials.read.mockReturnValue({ codex: { openaiApiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } } as never);
		ctx.login.codexProbe = 'logged_out';
		ctx.service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(ctx.apiKeys.submit).toHaveBeenCalledWith('codex-cli', 'sk-proj-abcdefghijklmnopqrstuvwxyz');
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['qa-1']);
	});

	it('a rejected key falls back to telling the owner', async () => {
		const ctx = setup();
		ctx.credentials.read.mockReturnValue({ codex: { openaiApiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } } as never);
		ctx.apiKeys.submit.mockRejectedValueOnce(new Error('invalid key'));
		ctx.login.codexProbe = 'logged_out';
		ctx.service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		expect(ctx.sent[0].text).toMatch(/Codex on iriss-air.lan is signed out/);
	});

	it('a key that did not help (expired again soon after) falls back to telling the owner', async () => {
		const ctx = setup();
		ctx.credentials.getClaudeCredentialKind.mockReturnValue('api_key' as never);
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'output' });
		await flush();
		jest.advanceTimersByTime(HARNESS_CONSTANTS.RELOGIN.POST_SUCCESS_QUIET_MS + 1);
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'output' });
		await flush();
		expect(ctx.sent).toHaveLength(1);
	});
});

describe('after a login', () => {
	it('ignores reports right after it (resumed transcripts repeat the old error)', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.login.probe = 'logged_in';
		ctx.broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		const before = ctx.sent.length;
		ctx.login.probe = 'logged_out';
		ctx.service.reportExpiry({ harnessId: 'claude-code', sessionName: 'ella-1', source: 'screen' });
		await flush();
		expect(ctx.sent).toHaveLength(before);
	});

	it('a dashboard sign-in while signed out completes the flow (resume, re-deliver, DM)', async () => {
		const ctx = setup();
		await signOutClaude(ctx);
		// The dashboard chip starts its own broker session and the owner pastes the code there.
		const web = ctx.broker.start('claude-code', 'subscription');
		ctx.login.probe = 'logged_in';
		ctx.broker.finish(web.id, 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.resumer.resume).toHaveBeenCalled();
		expect(ctx.onLoginRestored).toHaveBeenCalled();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/^Done: Claude Code on iriss-air.lan is signed in again/);
	});

	it('a dashboard sign-in with no flow restarts only the agents parked at a sign-in screen', async () => {
		const ctx = setup({ sessionNeedsLogin: (s) => s === 'ella-1' });
		const web = ctx.broker.start('claude-code', 'subscription');
		ctx.broker.finish(web.id, 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['ella-1']);
		expect(ctx.onLoginRestored).toHaveBeenCalledWith('claude-code', ['ella-1']);
		expect(ctx.sent).toHaveLength(0); // the owner did it on the dashboard and sees it there
	});

	it('reports agents that could not be restarted', async () => {
		const ctx = setup();
		ctx.resumer.resume.mockResolvedValueOnce({ resumed: ['crewly-orc'], failed: ['ella-1'] });
		await signOutClaude(ctx);
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.login.probe = 'logged_in';
		ctx.broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].text).toMatch(/1 agent resumed; 3 waiting messages re-delivered\. Could not restart: ella-1\.$/);
	});
});

describe('owner-requested login (relogin <harness>)', () => {
	it('「重新登录 claude」 starts a forced login even while signed in, answers in the thread, routes the code, reports success once', async () => {
		const ctx = setup();
		ctx.login.probe = 'logged_in';
		expect(ctx.service.handleOwnerReply('重新登录 claude', ORC_THREAD)).toBe(true);
		await flush();
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription' }]);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(ctx.sent).toHaveLength(1);
		expect(ctx.sent[0].target).toEqual(ORC_THREAD);
		expect(ctx.sent[0].text.split('\n')[0]).toBe('*Sign in to Claude Code on iriss-air.lan*');
		expect(ctx.service.handleOwnerReply(AUTH_CODE, ORC_THREAD)).toBe(true);
		expect(ctx.broker.inputs).toEqual([{ id: 's1', text: AUTH_CODE }]);
		ctx.broker.finish('s1', 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['crewly-orc', 'ella-1']);
		expect(ctx.sent[1]).toEqual({
			text: 'Done: Claude Code is signed in. 2 agents restarted on the new login; 3 waiting messages re-delivered.',
			target: ORC_THREAD,
		});
	});

	it('「换个账号登录 claude」 uses the account-switch wording', async () => {
		const ctx = setup();
		ctx.service.handleOwnerReply('换个账号登录 claude', ORC_THREAD);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(ctx.sent[0].text).toMatch(/^\*Switch the Claude Code account on iriss-air.lan\*/);
	});

	it('skips the silent API key: the owner asked for a link', async () => {
		const ctx = setup();
		ctx.credentials.getClaudeCredentialKind.mockReturnValue('api_key' as never);
		ctx.credentials.read.mockReturnValue({ codex: { openaiApiKey: 'sk-test' } });
		ctx.service.handleOwnerReply('relogin codex', ORC_THREAD);
		ctx.service.handleOwnerReply('relogin claude', ORC_THREAD);
		await flush();
		expect(ctx.apiKeys.submit).not.toHaveBeenCalled();
		expect(ctx.broker.startCalls.map((c) => c.harnessId)).toEqual(['codex-cli', 'claude-code']);
	});

	it('restarts a running flow with a fresh link, keeping the stuck agents', async () => {
		const ctx = setup({ agents: [], sessionsByHarness: {} });
		ctx.login.codexStatus = 'logged_out';
		ctx.service.reportExpiry({ harnessId: 'codex-cli', sessionName: 'qa-1', source: 'output' });
		await flush();
		ctx.service.handleOwnerReply('login', ORC_DM);
		ctx.broker.patch('s1', { state: 'awaiting_user', url: CODEX_URL, userCode: 'WH2P-EO69V' });
		await flush();
		const result = ctx.service.startOwnerLogin('codex-cli', { replyTarget: ORC_THREAD, requestedBy: 'orchestrator' });
		expect(result).toEqual({ status: 'restarted', harnessId: 'codex-cli', dmAvailable: true });
		expect(ctx.broker.sessions.get('s1')?.state).toBe('cancelled');
		ctx.broker.patch('s2', { state: 'awaiting_user', url: CODEX_URL, userCode: 'AB12-CD34' });
		await flush();
		expect(ctx.sent[ctx.sent.length - 1].target).toEqual(ORC_THREAD);
		ctx.login.codexStatus = 'logged_in';
		ctx.broker.finish('s2', 'succeeded', 'Logged in.');
		await flush();
		expect(ctx.resumer.resume).toHaveBeenCalledWith(['qa-1']);
	});

	it('asks which harness for an unknown one, and explains harnesses without a link login', async () => {
		const ctx = setup();
		expect(ctx.service.handleOwnerReply('登录 cursor', ORC_THREAD)).toBe(true);
		expect(ctx.service.handleOwnerReply('登录 agy', ORC_THREAD)).toBe(true);
		expect(ctx.service.handleOwnerReply('relogin gemini', ORC_THREAD)).toBe(true);
		expect(ctx.service.handleOwnerReply('login', ORC_THREAD)).toBe(true); // no flow: which one?
		await flush();
		expect(ctx.broker.startCalls).toHaveLength(0);
		expect(ctx.sent.map((m) => m.target)).toEqual([ORC_THREAD, ORC_THREAD, ORC_THREAD, ORC_THREAD]);
		expect(ctx.sent[0].text).toMatch(/doesn't run "cursor"/);
		expect(ctx.sent[1].text).toMatch(/Gemini API key/);
		expect(ctx.sent[2].text).toMatch(/enterprise-only/);
		expect(ctx.sent[3].text).toMatch(/^Which one should I sign in\?/);
		expect(ctx.service.startOwnerLogin('antigravity-cli', { requestedBy: 'orchestrator' })).toEqual({
			status: 'no_broker_login',
			harnessId: 'antigravity-cli',
			message: formatNoBrokerLoginDm('antigravity-cli'),
		});
	});

	it('leaves ordinary messages about logins to the orc', () => {
		const ctx = setup();
		expect(ctx.service.handleOwnerReply('claude 登录了吗', ORC_THREAD)).toBe(false);
		expect(ctx.service.handleOwnerReply('不 我要重新登陆一个账号', ORC_THREAD)).toBe(false);
		expect(ctx.broker.startCalls).toHaveLength(0);
	});

	it('a failed account switch (harness still fine) does not turn into "signed out" reminders', async () => {
		const ctx = setup();
		ctx.login.probe = 'logged_in';
		ctx.service.handleOwnerReply('换个账号登录 claude', ORC_THREAD);
		ctx.broker.finish('s1', 'timed_out', 'Login timed out.');
		await flush();
		const before = ctx.sent.length;
		jest.advanceTimersByTime(30 * HOUR);
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.sent).toHaveLength(before);
		expect(ctx.service.isSignedOut('claude-code')).toBe(false);
	});

	it('reports dmAvailable=false when there is no way to reach the owner', () => {
		const ctx = setup({ notifier: null });
		expect(ctx.service.startOwnerLogin('claude-code', { requestedBy: 'orchestrator' })).toEqual({
			status: 'started',
			harnessId: 'claude-code',
			dmAvailable: false,
		});
	});
});

describe('no notifier / no resumer', () => {
	it('still runs and logs that no DM path exists; a notice not delivered is retried later', async () => {
		const ctx = setup({ notifier: null, resumer: null });
		await signOutClaude(ctx);
		expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no Slack DM path/), expect.anything());
		expect(ctx.state.get('claude-code').lastNoticeAt).toBeUndefined();
		ctx.service.setNotifier({ sendToOwner: async () => false });
		await ctx.service.checkHarnesses();
		await flush();
		expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/not delivered/), expect.anything());
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

describe("HarnessReloginService — another of the owner's Claude Code accounts (#942)", () => {
	it('`login claude b` runs a login for account b, apart from the default login, and keeps the default flow alone', async () => {
		const ctx = setup({ listClaudeAccounts: () => ['b'] });
		const onAccountLogin = jest.fn(async () => undefined);
		ctx.service.setAccountLoginHandler(onAccountLogin);
		expect(ctx.service.handleOwnerReply('login claude b', ORC_THREAD)).toBe(true);
		await flush();
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription', account: 'b' }]);
		const id = [...ctx.broker.sessions.keys()][0];

		ctx.broker.patch(id, { state: 'awaiting_user', url: CLAUDE_URL, needsInput: true });
		await flush();
		expect(ctx.dms[0]).toContain('*Sign in to Claude Code account `b` on iriss-air.lan*');
		expect(ctx.dms[0]).toContain(CLAUDE_URL);

		// The code goes into account b's login.
		expect(ctx.service.handleOwnerReply(AUTH_CODE, ORC_THREAD)).toBe(true);
		expect(ctx.broker.inputs).toEqual([{ id, text: AUTH_CODE }]);

		ctx.broker.finish(id, 'succeeded', 'Logged in.');
		await flush();
		// No agent is restarted, no default-login probe; the fallback learns about it.
		expect(ctx.resumer.resume).not.toHaveBeenCalled();
		expect(ctx.verifyLogin).not.toHaveBeenCalled();
		expect(onAccountLogin).toHaveBeenCalledWith('b');
		expect(ctx.dms[ctx.dms.length - 1]).toMatch(/^Done: Claude Code account `b` is signed in on iriss-air\.lan\./);
		expect(ctx.dms[ctx.dms.length - 1]).toContain('moving to it now');
		expect(ctx.dms[ctx.dms.length - 1]).not.toContain('Settings');
		expect(ctx.state.get('claude-code').seenLoggedInAt).toBeUndefined();
	});

	it('`login claude please` is not an account (no such account)', async () => {
		const ctx = setup({ listClaudeAccounts: () => ['b'] });
		expect(ctx.service.handleOwnerReply('login claude please', ORC_THREAD)).toBe(false);
		expect(ctx.broker.startCalls).toEqual([]);
		// A new account is named explicitly.
		expect(ctx.service.handleOwnerReply('login claude@work', ORC_THREAD)).toBe(true);
		await flush();
		expect(ctx.broker.startCalls).toEqual([{ harnessId: 'claude-code', method: 'subscription', account: 'work' }]);
	});

	it('startOwnerLogin with an account reports it; other harnesses have no accounts', () => {
		const ctx = setup();
		expect(ctx.service.startOwnerLogin('claude-code', { requestedBy: 'dashboard', account: 'work' })).toEqual({
			status: 'started',
			harnessId: 'claude-code',
			account: 'work',
			dmAvailable: true,
		});
		// The default login runs in its own flow alongside.
		ctx.service.startOwnerLogin('claude-code', { requestedBy: 'orchestrator' });
		expect(ctx.broker.startCalls).toEqual([
			{ harnessId: 'claude-code', method: 'subscription', account: 'work' },
			{ harnessId: 'claude-code', method: 'subscription' },
		]);
		expect(ctx.service.startOwnerLogin('codex-cli', { requestedBy: 'dashboard', account: 'work' })).toMatchObject({ status: 'no_broker_login' });
	});

	it("an expired account link asks again by the account's name, without reminders", async () => {
		const ctx = setup();
		ctx.service.startOwnerLogin('claude-code', { requestedBy: 'dashboard', account: 'work' });
		const id = [...ctx.broker.sessions.keys()][0];
		ctx.broker.finish(id, 'timed_out', 'The login was not completed in time.');
		await flush();
		expect(ctx.dms[ctx.dms.length - 1]).toBe(
			'The sign-in link for Claude Code account `work` on iriss-air.lan expired before it was used. Reply `login claude work` for a fresh one.',
		);
	});

	it('an account signed in from the dashboard (no flow) still tells the fallback', async () => {
		const ctx = setup();
		const onAccountLogin = jest.fn();
		ctx.service.setAccountLoginHandler(onAccountLogin);
		const session = ctx.broker.start('claude-code', 'subscription', { account: 'b' });
		ctx.broker.finish(session.id, 'succeeded', 'Logged in.');
		await flush();
		expect(onAccountLogin).toHaveBeenCalledWith('b');
		expect(ctx.resumer.resume).not.toHaveBeenCalled();
	});
});
