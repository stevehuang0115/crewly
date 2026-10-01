/**
 * Agent-free re-login, end to end inside the backend (the Air, 2026-09-30):
 * every agent and the orchestrator run Claude Code, its login expired, no
 * agent can do anything. The real login broker (with a fake PTY standing in
 * for `claude setup-token`), the real coordinator, the real Slack DM adapter
 * and inbound interceptor, and the real owner-message watchdog are wired
 * together; only Slack, the PTY, the probe and the agent restarts are fakes.
 * Credentials go to a temp file — never the real ~/.claude.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import { OwnerMessageWatchdogService } from '../messaging/owner-message-watchdog.service.js';
import { SlackReloginDmService, createReloginReplyInterceptor, type ReloginDmSlackApi } from '../slack/slack-relogin-dm.service.js';
import { HarnessCredentialsStore } from './harness-credentials.store.js';
import { HarnessReloginService, harnessCommandWord, type ConfiguredAgent } from './harness-relogin.service.js';
import type { HarnessId, LoginState } from './harness.types.js';
import { LoginBrokerService, type BrokerPty } from './login-broker.service.js';
import { MemoryReloginStateStore } from './relogin-state.store.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

/** Fake PTY standing in for `claude setup-token`. */
class FakePty implements BrokerPty {
	written: string[] = [];
	killed = false;
	private dataListeners: Array<(data: string) => void> = [];
	private exitListeners: Array<(event: { exitCode: number }) => void> = [];
	onData(listener: (data: string) => void): void {
		this.dataListeners.push(listener);
	}
	onExit(listener: (event: { exitCode: number }) => void): void {
		this.exitListeners.push(listener);
	}
	write(data: string): void {
		this.written.push(data);
	}
	kill(): void {
		this.killed = true;
	}
	emit(data: string): void {
		for (const listener of this.dataListeners) listener(data);
	}
	exit(exitCode: number): void {
		for (const listener of this.exitListeners) listener({ exitCode });
	}
}

const CLAUDE_URL =
	'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&code_challenge_method=S256&state=HIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx';
const PROMPT = '\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>';
const CLAUDE_SCREEN = ["Browser didn't open? Use the url below to sign in (c to copy)", CLAUDE_URL, '', PROMPT, ''].join('\r\n');
const INVALID_CODE_SCREEN = ['', 'Invalid code. Please make sure the full code was copied', PROMPT, ''].join('\r\n');
const TOKEN = `sk-ant-oat01-${'Zq9'.repeat(30)}-AA`;
const TOKEN_SCREEN = ['Your OAuth token (valid for 1 year):', TOKEN, "Store this token securely. You won't be able to see it again.", ''].join('\r\n');
const AUTH_CODE = 'Kq3xZ8vN2mP7rT4wY1bC6dF9gH0jL5nQ#9f8e7d6c5b4a';
const OWNER = 'UOWNER';
/** The owner's DM with the Air's own "Crewly Orc (iriss-air.lan)" bot. */
const ORC_BOT_DM = 'DORCAIR';

const AGENTS: ConfiguredAgent[] = [
	{ sessionName: 'crewly-orc', harnessId: 'claude-code', displayName: 'Crewly Orc' },
	{ sessionName: 'ella-1', harnessId: 'claude-code', displayName: 'Ella' },
];

/** Let queued promise callbacks run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

describe('agent-free re-login from the phone (Claude Code, zero agents able to run)', () => {
	let dir: string;
	let ptys: FakePty[];
	let posts: Array<{ channelId: string; text: string; botToken?: string; threadTs?: string }>;
	let probeState: LoginState;
	let resumed: string[][];
	let nudged: string[];
	let notes: string[];
	let broker: LoginBrokerService;
	let relogin: HarnessReloginService;
	let watchdog: OwnerMessageWatchdogService;
	let intercept: (message: SlackIncomingMessage) => boolean;
	let credentials: HarnessCredentialsStore;
	let clock: { t: number };

	/**
	 * An owner DM arriving from Cloud (as the Slack bridge sees it).
	 *
	 * @param text - Message text
	 * @param channelId - DM channel
	 * @param agentSession - Agent whose bot the DM is with
	 * @returns Whether the backend consumed it before any agent saw it
	 */
	function ownerSays(text: string, channelId = ORC_BOT_DM, agentSession = 'crewly-orc'): boolean {
		return intercept({ id: 'm', type: 'message', text, userId: OWNER, channelId, ts: `${posts.length}.1`, teamId: 'T', eventTs: '1', agentSession, source: 'cloud' });
	}

	beforeEach(() => {
		jest.useFakeTimers();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentless-relogin-'));
		ptys = [];
		posts = [];
		resumed = [];
		nudged = [];
		notes = [];
		probeState = 'logged_out';
		clock = { t: 1_000_000 };
		credentials = new HarnessCredentialsStore(path.join(dir, 'harness-credentials.json'));
		let n = 0;
		broker = new LoginBrokerService({
			submitDelayMs: 0,
			spawnPty: () => {
				const pty = new FakePty();
				ptys.push(pty);
				return pty;
			},
			resolveCommand: (cmd) => `/fake/bin/${cmd}`,
			env: { PATH: '/usr/bin', HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
			homeDir: dir,
			credentials,
			prepareClaudeConfig: () => undefined,
			verify: async () => true,
			idFactory: () => `login-${++n}`,
		});
		const slack: ReloginDmSlackApi = {
			isConnected: () => true,
			getOwnerUserId: () => OWNER,
			isAgentOwnedConversation: () => false,
			openDirectMessage: async (_user: string, botToken?: string) => (botToken === 'xoxb-orc-air' ? ORC_BOT_DM : 'DMASTER'),
			sendMessage: async (m) => {
				posts.push({ channelId: m.channelId, text: m.text, botToken: m.botToken, threadTs: m.threadTs });
				return `${posts.length}.0`;
			},
			sendNotification: async () => undefined,
		};
		const dm = new SlackReloginDmService(() => slack, undefined, (session) => (session === 'crewly-orc' ? 'xoxb-orc-air' : null));
		relogin = new HarnessReloginService({
			broker,
			credentials,
			apiKeys: { submit: async () => undefined },
			// The expired login is still stored: the status command says logged in.
			checkLoginState: async () => 'logged_in',
			verifyLogin: async (harnessId: HarnessId) => (harnessId === 'claude-code' ? probeState : 'logged_in'),
			getOrcHarness: async () => 'claude-code',
			listAgents: async () => AGENTS,
			machineName: () => 'iriss-air.lan',
			state: new MemoryReloginStateStore(),
			notifier: dm,
			// No agent is running at all.
			resumer: {
				listSessions: () => [],
				resume: async (names) => {
					resumed.push([...names]);
					return { resumed: [...names], failed: [] };
				},
			},
			onLoginRestored: (harnessId, sessions) => watchdog.resumeAfterLogin({ runtimeCmd: harnessCommandWord(harnessId), sessions }),
		});
		watchdog = new OwnerMessageWatchdogService({
			isBusy: () => false,
			nudge: async (entry) => {
				nudged.push(entry.responsible);
				return { outcome: 'sent' };
			},
			postNote: async (_entry, text) => {
				notes.push(text);
				return true;
			},
			loginRequired: (session) => (relogin.signedOutHarnessOf(session) ? { runtime: 'Claude Code', runtimeCmd: 'claude' } : null),
			displayNameOf: (s) => (s === 'ella-1' ? 'Ella' : s),
			now: () => clock.t,
		});
		intercept = createReloginReplyInterceptor(dm, relogin);
	});

	afterEach(() => {
		relogin.stop();
		jest.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('detect → one DM from this machine\'s orc bot → `login` → link → code → signed in, agents resumed, waiting message re-delivered', async () => {
		// 1. Detection with zero agents running: the periodic check probes the harness.
		await relogin.checkHarnesses();
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ channelId: ORC_BOT_DM, botToken: 'xoxb-orc-air' });
		expect(posts[0].text).toBe(
			"*Claude Code on iriss-air.lan is signed out*, so 2 agents can't work (Crewly Orc, Ella).\nReply `login` here to sign in from your phone (or `relogin claude`).",
		);

		// The owner wrote to Ella meanwhile; nobody can answer. The watchdog parks it.
		watchdog.track({ surface: 'slack', slackChannelId: 'DELLA', sourceTs: '5.5', threadTs: '5.5', responsible: 'ella-1', recipients: ['ella-1'], required: true, text: 'Send me the EFT sheet' });
		clock.t += 11 * 60 * 1000;
		await watchdog.tick();
		expect(nudged).toHaveLength(0);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/Still waiting on Ella — Claude Code on this machine is signed out\. Reply `login` here/);
		expect(watchdog.size).toBe(1);

		// 2. The owner replies `login` in the orc-bot DM: the backend takes it (no agent).
		expect(ownerSays('login')).toBe(true);
		expect(ptys).toHaveLength(1);
		ptys[0].emit(CLAUDE_SCREEN);
		await flush();
		expect(posts).toHaveLength(2);
		expect(posts[1].channelId).toBe(ORC_BOT_DM);
		expect(posts[1].botToken).toBe('xoxb-orc-air');
		expect(posts[1].text.split('\n')[0]).toBe('*Sign in to Claude Code on iriss-air.lan*');
		// Slack-escaped, but the URL survives intact (Slack decodes &amp;).
		expect(posts[1].text.replace(/&amp;/g, '&').split('\n')).toContain(CLAUDE_URL);

		// 3. A wrong code first.
		expect(ownerSays('wrong-code-0123456789')).toBe(true);
		expect(ptys[0].written.join('')).toContain('wrong-code-0123456789\r');
		ptys[0].emit(INVALID_CODE_SCREEN);
		await flush();
		expect(posts[posts.length - 1].text).toMatch(/^That code didn't work \(Invalid code/);

		// 4. The right code; the harness prints the token; the probe confirms.
		expect(ownerSays(AUTH_CODE)).toBe(true);
		expect(ptys[0].written.join('')).toContain(`${AUTH_CODE}\r`);
		probeState = 'logged_in';
		ptys[0].emit(TOKEN_SCREEN);
		ptys[0].exit(0);
		await flush();
		await flush();

		expect(credentials.getClaudeCredentialKind()).toBe('oauth_token');
		expect(resumed).toEqual([]); // nothing was running
		expect(nudged).toEqual(['ella-1']);
		const done = posts[posts.length - 1];
		expect(done.channelId).toBe(ORC_BOT_DM);
		expect(done.text).toBe('Done: Claude Code on iriss-air.lan is signed in again. 0 agents resumed; 1 waiting message re-delivered.');
		// The token and the code never reached Slack.
		for (const post of posts) {
			expect(post.text).not.toContain(TOKEN);
			expect(post.text).not.toContain(AUTH_CODE);
		}
		expect(relogin.isSignedOut('claude-code')).toBe(false);
		// The watchdog's entry is back on its normal timeline, then answered.
		watchdog.noteSlackAnswer('DELLA', '5.5', 'post');
		expect(watchdog.size).toBe(0);
	});

	it('`login` written in Ella\'s own DM (answering the watchdog note) works the same way', async () => {
		await relogin.checkHarnesses();
		await flush();
		expect(ownerSays('login', 'DELLA', 'ella-1')).toBe(true);
		ptys[0].emit(CLAUDE_SCREEN);
		await flush();
		// Answered where the owner asked; Ella has no bot token here, so it falls back to this machine's DM.
		expect(posts[posts.length - 1].text.split('\n')[0]).toBe('*Sign in to Claude Code on iriss-air.lan*');
		// Ordinary mail to Ella is not taken.
		expect(ownerSays('how is the EFT sheet going?', 'DELLA', 'ella-1')).toBe(false);
	});

	it('an expired link: told once, nothing started until the owner replies again', async () => {
		await relogin.checkHarnesses();
		await flush();
		ownerSays('login');
		ptys[0].emit(CLAUDE_SCREEN);
		await flush();
		jest.advanceTimersByTime(16 * 60 * 1000); // broker timeout (15 min)
		await flush();
		expect(posts[posts.length - 1].text).toMatch(/^The sign-in link for Claude Code on iriss-air.lan expired before it was used/);
		expect(ptys[0].killed).toBe(true);
		expect(ptys).toHaveLength(1);
		expect(ownerSays('login')).toBe(true);
		expect(ptys).toHaveLength(2);
	});
});
