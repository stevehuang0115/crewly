/**
 * Tests for OAuthReloginMonitorService.
 *
 * Verifies OAuth token expiry detection, /login command sending,
 * URL capture from PTY output, event emission, OAuth code callback,
 * cooldown/rate-limiting, and session lifecycle management.
 */

import { OAuthReloginMonitorService } from './oauth-relogin-monitor.service.js';
import { OAUTH_RELOGIN_CONSTANTS } from '../../constants.js';

// =============================================================================
// Mocks
// =============================================================================

/** Captured onData callback from mock session */
let capturedOnDataCallback: ((data: string) => void) | null = null;

/** Mock session write calls */
const mockSessionWrite = jest.fn();

/** Mock session */
const mockSession = {
	write: mockSessionWrite,
	onData: jest.fn((callback: (data: string) => void) => {
		capturedOnDataCallback = callback;
		return () => {
			capturedOnDataCallback = null;
		};
	}),
};

/** Mock session backend */
const mockBackend = {
	getSession: jest.fn().mockReturnValue(mockSession),
	sessionExists: jest.fn().mockReturnValue(true),
	captureOutput: jest.fn().mockReturnValue(''),
	listSessions: jest.fn().mockReturnValue([]),
};

jest.mock('../session/index.js', () => ({
	getSessionBackendSync: jest.fn(() => mockBackend),
	createSessionCommandHelper: jest.fn(),
}));

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				debug: jest.fn(),
			}),
		}),
	},
}));

jest.mock('../../utils/terminal-output.utils.js', () => ({
	stripAnsiCodes: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ''),
}));

/** Mock uuid */
jest.mock('uuid', () => ({
	v4: () => 'test-uuid-1234',
}));

// =============================================================================
// Helpers
// =============================================================================

/**
 * Advance through debounce + pre-command delay using the async timer API.
 */
async function advancePastRelogin(): Promise<void> {
	await jest.advanceTimersByTimeAsync(
		OAUTH_RELOGIN_CONSTANTS.DETECTION_DEBOUNCE_MS +
		OAUTH_RELOGIN_CONSTANTS.PRE_COMMAND_DELAY_MS + 100
	);
}

// =============================================================================
// Tests
// =============================================================================

describe('OAuthReloginMonitorService', () => {
	let service: OAuthReloginMonitorService;

	beforeEach(() => {
		jest.useFakeTimers();
		OAuthReloginMonitorService.resetInstance();
		service = OAuthReloginMonitorService.getInstance();
		capturedOnDataCallback = null;
		mockSessionWrite.mockClear();
		mockSession.onData.mockClear();
		mockBackend.getSession.mockClear();
		mockBackend.getSession.mockReturnValue(mockSession);
		mockBackend.sessionExists.mockReturnValue(true);
		mockBackend.captureOutput.mockReset().mockReturnValue('');
		mockBackend.listSessions.mockReset().mockReturnValue([]);
	});

	afterEach(() => {
		OAuthReloginMonitorService.resetInstance();
		jest.useRealTimers();
	});

	// =========================================================================
	// Singleton
	// =========================================================================

	describe('singleton', () => {
		it('returns the same instance', () => {
			const a = OAuthReloginMonitorService.getInstance();
			const b = OAuthReloginMonitorService.getInstance();
			expect(a).toBe(b);
		});

		it('resets to a new instance', () => {
			const a = OAuthReloginMonitorService.getInstance();
			OAuthReloginMonitorService.resetInstance();
			const b = OAuthReloginMonitorService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	// =========================================================================
	// Monitoring lifecycle
	// =========================================================================

	describe('startMonitoring', () => {
		it('subscribes to PTY data', () => {
			service.startMonitoring('test-session', 'claude-code');
			expect(mockSession.onData).toHaveBeenCalledTimes(1);
			expect(service.isMonitoring('test-session')).toBe(true);
		});

		it('replaces existing monitoring on double start', () => {
			service.startMonitoring('test-session', 'claude-code');
			service.startMonitoring('test-session', 'claude-code');
			expect(service.isMonitoring('test-session')).toBe(true);
		});

		it('does not subscribe when backend is unavailable', () => {
			const { getSessionBackendSync } = require('../session/index.js');
			getSessionBackendSync.mockReturnValueOnce(null);
			service.startMonitoring('test-session', 'claude-code');
			expect(service.isMonitoring('test-session')).toBe(false);
		});

		it('does not subscribe when session is not found', () => {
			mockBackend.getSession.mockReturnValueOnce(null);
			service.startMonitoring('test-session', 'claude-code');
			expect(service.isMonitoring('test-session')).toBe(false);
		});
	});

	describe('stopMonitoring', () => {
		it('unsubscribes from PTY data', () => {
			service.startMonitoring('test-session', 'claude-code');
			expect(service.isMonitoring('test-session')).toBe(true);
			service.stopMonitoring('test-session');
			expect(service.isMonitoring('test-session')).toBe(false);
		});

		it('is safe to call on non-monitored session', () => {
			expect(() => service.stopMonitoring('nonexistent')).not.toThrow();
		});
	});

	describe('destroy', () => {
		it('stops all monitored sessions', () => {
			service.startMonitoring('session-1', 'claude-code');
			service.startMonitoring('session-2', 'claude-code');
			service.destroy();
			expect(service.isMonitoring('session-1')).toBe(false);
			expect(service.isMonitoring('session-2')).toBe(false);
		});
	});

	// =========================================================================
	// OAuth error detection
	// =========================================================================

	describe('OAuth error detection', () => {
		function feedData(data: string): void {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
			if (capturedOnDataCallback) {
				capturedOnDataCallback(data);
			}
		}

		it('detects "authentication_error" + "OAuth token has expired"', async () => {
			feedData('Error: authentication_error - Your OAuth token has expired. Please re-authenticate.');
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('\x1b');
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});

		it('detects case-insensitive patterns', async () => {
			feedData('AUTHENTICATION_ERROR: OAUTH TOKEN HAS EXPIRED');
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});

		it('detects "401" + "OAuth token has expired"', async () => {
			feedData('HTTP 401 Unauthorized: OAuth token has expired');
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});

		it('detects "authentication_error" + "Invalid authentication credentials"', async () => {
			feedData('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_test"} · Please run /login');
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('\x1b');
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});

		it('detects "401" + "Invalid authentication credentials"', async () => {
			feedData('HTTP 401: Invalid authentication credentials');
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});

		it('does not trigger on partial matches', async () => {
			feedData('authentication_error: invalid credentials');
			await advancePastRelogin();
			expect(mockSessionWrite).not.toHaveBeenCalled();
		});

		it('does not trigger on unrelated output', async () => {
			feedData('Successfully deployed version 1.2.3');
			await advancePastRelogin();
			expect(mockSessionWrite).not.toHaveBeenCalled();
		});

		it('does not trigger during startup grace period', async () => {
			service.startMonitoring('test-session', 'claude-code');
			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();
			expect(mockSessionWrite).not.toHaveBeenCalled();
		});

		it('accumulates data across multiple chunks', async () => {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
			if (capturedOnDataCallback) {
				capturedOnDataCallback('Error: authentication_error ');
				capturedOnDataCallback('- OAuth token has expired');
			}
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});
	});

	// =========================================================================
	// URL capture mode
	// =========================================================================

	describe('URL capture mode', () => {
		async function triggerLoginAndEnterCaptureMode(): Promise<void> {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();
		}

		it('enters capture mode after sending /login', async () => {
			await triggerLoginAndEnterCaptureMode();

			const state = service.getState('test-session');
			expect(state).toBeDefined();
			expect(state!.captureMode).toBe('capturing');
		});

		it('extracts OAuth URL from PTY output', async () => {
			await triggerLoginAndEnterCaptureMode();

			// Simulate OAuth URL appearing in PTY output
			if (capturedOnDataCallback) {
				capturedOnDataCallback('Open this URL to authenticate:\nhttps://console.anthropic.com/oauth/authorize?client_id=abc123&redirect_uri=...\n');
			}

			const state = service.getState('test-session');
			expect(state).toBeDefined();
			expect(state!.captureMode).toBe('idle');
			expect(state!.lastCapturedUrl).toBe('https://console.anthropic.com/oauth/authorize?client_id=abc123&redirect_uri=...');
		});

		it('extracts URL with /login path', async () => {
			await triggerLoginAndEnterCaptureMode();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('Visit https://auth.example.com/login?token=xyz to sign in');
			}

			const state = service.getState('test-session');
			expect(state!.lastCapturedUrl).toBe('https://auth.example.com/login?token=xyz');
		});

		it('extracts URL with /auth path', async () => {
			await triggerLoginAndEnterCaptureMode();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('Go to https://example.com/auth/callback?code=123');
			}

			const state = service.getState('test-session');
			expect(state!.lastCapturedUrl).toBe('https://example.com/auth/callback?code=123');
		});

		it('ignores non-OAuth URLs during capture', async () => {
			await triggerLoginAndEnterCaptureMode();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('Documentation at https://docs.example.com/api/reference');
			}

			const state = service.getState('test-session');
			expect(state!.captureMode).toBe('capturing');
			expect(state!.lastCapturedUrl).toBeNull();
		});

		it('times out URL capture after timeout period', async () => {
			await triggerLoginAndEnterCaptureMode();

			const state = service.getState('test-session');
			expect(state!.captureMode).toBe('capturing');

			// Advance past capture timeout
			await jest.advanceTimersByTimeAsync(OAUTH_RELOGIN_CONSTANTS.URL_CAPTURE_TIMEOUT_MS + 1);

			expect(state!.captureMode).toBe('idle');
			expect(state!.captureBuffer).toBe('');
		});

		it('accumulates capture data across chunks', async () => {
			await triggerLoginAndEnterCaptureMode();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('Visit https://console.anthropic');
				capturedOnDataCallback('.com/oauth/authorize?id=abc');
			}

			const state = service.getState('test-session');
			expect(state!.captureMode).toBe('idle');
			expect(state!.lastCapturedUrl).toBe('https://console.anthropic.com/oauth/authorize?id=abc');
		});
	});

	// =========================================================================
	// Event emission
	// =========================================================================

	describe('event emission', () => {
		it('publishes agent:oauth_url event via EventBus', async () => {
			const mockPublish = jest.fn();
			const mockEventBus = { publish: mockPublish } as any;
			service.setEventBusService(mockEventBus);

			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();

			// Feed OAuth URL
			if (capturedOnDataCallback) {
				capturedOnDataCallback('https://console.anthropic.com/oauth/authorize?id=test');
			}

			expect(mockPublish).toHaveBeenCalledTimes(1);
			const event = mockPublish.mock.calls[0][0];
			expect(event.type).toBe('agent:oauth_url');
			expect(event.sessionName).toBe('test-session');
			expect(event.newValue).toBe('https://console.anthropic.com/oauth/authorize?id=test');
			expect(event.changedField).toBe('oauthUrl');
		});

		it('invokes onOAuthUrl callback', async () => {
			const mockCallback = jest.fn();
			service.setOnOAuthUrlCallback(mockCallback);

			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('https://console.anthropic.com/oauth/authorize?id=test');
			}

			expect(mockCallback).toHaveBeenCalledWith(
				'test-session',
				'https://console.anthropic.com/oauth/authorize?id=test'
			);
		});

		it('handles callback errors gracefully', async () => {
			const errorCallback = jest.fn(() => { throw new Error('callback error'); });
			service.setOnOAuthUrlCallback(errorCallback);

			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();

			// Should not throw
			expect(() => {
				if (capturedOnDataCallback) {
					capturedOnDataCallback('https://console.anthropic.com/oauth/authorize?id=test');
				}
			}).not.toThrow();
		});
	});

	// =========================================================================
	// OAuth code submission
	// =========================================================================

	describe('submitOAuthCode', () => {
		it('writes code + Enter to the PTY session', () => {
			service.startMonitoring('test-session', 'claude-code');

			const result = OAuthReloginMonitorService.submitOAuthCode('test-session', 'my-auth-code-123');

			expect(result).toBe(true);
			expect(mockSessionWrite).toHaveBeenCalledWith('my-auth-code-123\r');
		});

		it('resets capture mode after code submission', async () => {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Trigger login to enter capture mode
			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();

			const state = service.getState('test-session');
			expect(state!.captureMode).toBe('capturing');

			// Submit code
			OAuthReloginMonitorService.submitOAuthCode('test-session', 'code-123');

			expect(state!.captureMode).toBe('idle');
			expect(state!.captureBuffer).toBe('');
		});

		it('returns false when backend is unavailable', () => {
			const { getSessionBackendSync } = require('../session/index.js');
			getSessionBackendSync.mockReturnValueOnce(null);

			const result = OAuthReloginMonitorService.submitOAuthCode('test-session', 'code');
			expect(result).toBe(false);
		});

		it('returns false when session is not found', () => {
			mockBackend.getSession.mockReturnValueOnce(null);

			const result = OAuthReloginMonitorService.submitOAuthCode('test-session', 'code');
			expect(result).toBe(false);
		});
	});

	// =========================================================================
	// Cooldown and rate limiting
	// =========================================================================

	describe('cooldown and rate limiting', () => {
		function startAndPassGrace(): void {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
		}

		it('respects cooldown between /login attempts', async () => {
			startAndPassGrace();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
			mockSessionWrite.mockClear();

			// Second trigger within cooldown — should not fire
			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();
			expect(mockSessionWrite).not.toHaveBeenCalled();

			// Advance past cooldown
			await jest.advanceTimersByTimeAsync(OAUTH_RELOGIN_CONSTANTS.RELOGIN_COOLDOWN_MS);
			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});

		it('limits attempts within the attempt window', async () => {
			startAndPassGrace();

			for (let i = 0; i < OAUTH_RELOGIN_CONSTANTS.MAX_ATTEMPTS_PER_WINDOW; i++) {
				if (capturedOnDataCallback) {
					capturedOnDataCallback('authentication_error - OAuth token has expired');
				}
				await advancePastRelogin();
				await jest.advanceTimersByTimeAsync(OAUTH_RELOGIN_CONSTANTS.RELOGIN_COOLDOWN_MS);
			}

			const callCount = mockSessionWrite.mock.calls.filter(
				(c: unknown[]) => c[0] === '/login\r'
			).length;
			expect(callCount).toBe(OAUTH_RELOGIN_CONSTANTS.MAX_ATTEMPTS_PER_WINDOW);
			mockSessionWrite.mockClear();

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();
			expect(mockSessionWrite).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Gemini CLI handling
	// =========================================================================

	describe('Gemini CLI handling', () => {
		it('skips Escape key for Gemini CLI', async () => {
			service.startMonitoring('gemini-session', 'gemini-cli');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}

			await advancePastRelogin();

			expect(mockSessionWrite).not.toHaveBeenCalledWith('\x1b');
			expect(mockSessionWrite).toHaveBeenCalledWith('/login\r');
		});
	});

	// =========================================================================
	// Buffer management
	// =========================================================================

	describe('buffer management', () => {
		it('caps buffer at MAX_BUFFER_SIZE', () => {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			const largeData = 'x'.repeat(OAUTH_RELOGIN_CONSTANTS.MAX_BUFFER_SIZE + 1000);
			if (capturedOnDataCallback) {
				capturedOnDataCallback(largeData);
			}

			const state = service.getState('test-session');
			expect(state).toBeDefined();
			expect(state!.buffer.length).toBeLessThanOrEqual(OAUTH_RELOGIN_CONSTANTS.MAX_BUFFER_SIZE);
		});

		it('clears buffer after successful /login trigger', async () => {
			service.startMonitoring('test-session', 'claude-code');
			jest.advanceTimersByTime(OAUTH_RELOGIN_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			if (capturedOnDataCallback) {
				capturedOnDataCallback('authentication_error - OAuth token has expired');
			}
			await advancePastRelogin();

			const state = service.getState('test-session');
			expect(state).toBeDefined();
			expect(state!.buffer).toBe('');
		});
	});

	// =========================================================================
	// First-run / device-code login detection (server-install finding 7)
	// =========================================================================

	const CODEX_DEVICE_CODE_SCREEN = [
		'  Welcome to Codex, OpenAI\'s command-line coding agent',
		'',
		'  Sign in with your ChatGPT account using a device code',
		'',
		'  1. Go to https://auth.openai.com/codex/device',
		'  2. Enter the code: FBVZ-MJHKK',
		'',
		'  The code expires in 15 minutes.',
		'',
		'  Press esc to go back',
	].join('\n');

	const CODEX_BROWSER_SIGNIN_SCREEN = [
		'  Welcome to Codex',
		'',
		'  Sign in with ChatGPT to use Codex as part of your paid ChatGPT plan',
		'',
		'› 1. Sign in with ChatGPT',
		'  2. Provide your own API key',
	].join('\n');

	const CLAUDE_LOGIN_SCREEN = [
		"  Browser didn't open? Use the url below to sign in:",
		'',
		'  https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code',
		'',
		'  Paste code here if prompted >',
	].join('\n');

	const CODEX_IDLE_SCREEN = [
		'│ model:     gpt-5-codex   /model to change │',
		'',
		'› Ask Codex to do anything',
		'',
		'  ? for shortcuts                       gpt-5-codex · /root/.crewly',
	].join('\n');

	describe('detectLoginRequired', () => {
		it('extracts the device URL and XXXX-XXXXX code from the Codex device-code screen', () => {
			expect(service.detectLoginRequired(CODEX_DEVICE_CODE_SCREEN)).toEqual({
				url: 'https://auth.openai.com/codex/device',
				code: 'FBVZ-MJHKK',
			});
		});

		it('detects the Codex browser sign-in screen (no URL, no code)', () => {
			expect(service.detectLoginRequired(CODEX_BROWSER_SIGNIN_SCREEN)).toEqual({ url: null, code: null });
		});

		it('extracts the Claude Code OAuth URL from its login screen', () => {
			expect(service.detectLoginRequired(CLAUDE_LOGIN_SCREEN)).toEqual({
				url: 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code',
				code: null,
			});
		});

		it('returns null for an idle runtime screen', () => {
			expect(service.detectLoginRequired(CODEX_IDLE_SCREEN)).toBeNull();
		});

		it('returns null for empty input', () => {
			expect(service.detectLoginRequired('')).toBeNull();
		});

		it('ignores ANSI colour codes around the code', () => {
			const withAnsi = CODEX_DEVICE_CODE_SCREEN.replace('FBVZ-MJHKK', '\x1b[1mFBVZ-MJHKK\x1b[0m');
			expect(service.detectLoginRequired(withAnsi)?.code).toBe('FBVZ-MJHKK');
		});

		it('does not mistake lowercase hex or short segments for a device code', () => {
			const screen = CODEX_DEVICE_CODE_SCREEN.replace('FBVZ-MJHKK', 'a1b2-c3d4e5').replace('code:', 'code: GPT-5 ');
			expect(service.detectLoginRequired(screen)?.code).toBeNull();
		});
	});

	describe('inspectScreen / notification path', () => {
		const mockEventBus = { publish: jest.fn() };
		const mockQueue = { enqueue: jest.fn() };
		const mockSlack = { isConnected: jest.fn().mockReturnValue(true), sendNotification: jest.fn().mockResolvedValue(undefined) };
		const mockChat = {
			getActiveConversationId: jest.fn().mockReturnValue('conv-1'),
			recordSystemTurn: jest.fn(),
			broadcastSystemNotification: jest.fn(),
		};

		beforeEach(() => {
			mockEventBus.publish.mockClear();
			mockQueue.enqueue.mockClear();
			mockSlack.isConnected.mockClear().mockReturnValue(true);
			mockSlack.sendNotification.mockClear();
			mockChat.getActiveConversationId.mockClear().mockReturnValue('conv-1');
			mockChat.recordSystemTurn.mockClear();
			mockChat.broadcastSystemNotification.mockClear();
			service.setEventBusService(mockEventBus as any);
			service.setNoticeQueue(mockQueue);
			service.setSlackProvider(async () => mockSlack);
			service.setChatProvider(() => mockChat);
		});

		it('flags the session, publishes agent:login_required, enqueues a [NOTIFY], surfaces in chat and Slack', async () => {
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();

			const pending = service.getLoginRequired('agent-dev-001');
			expect(pending).toMatchObject({
				sessionName: 'agent-dev-001',
				runtimeType: 'codex-cli',
				url: 'https://auth.openai.com/codex/device',
				code: 'FBVZ-MJHKK',
			});
			expect(pending!.detectedAt).toBeTruthy();

			expect(mockEventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
				type: 'agent:login_required',
				sessionName: 'agent-dev-001',
				newValue: 'https://auth.openai.com/codex/device',
				loginCode: 'FBVZ-MJHKK',
				changedField: 'loginRequired',
			}));

			const expectedText = 'Agent agent-dev-001 needs you to sign in: https://auth.openai.com/codex/device code FBVZ-MJHKK';
			expect(mockQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
				content: `[NOTIFY] ${expectedText}`,
				source: 'system_event',
				targetSession: 'crewly-orc',
			}));
			expect(mockChat.recordSystemTurn).toHaveBeenCalledWith('conv-1', `[Login required] ${expectedText}`);
			expect(mockChat.broadcastSystemNotification).toHaveBeenCalledWith(expectedText, 'warning');
			expect(mockSlack.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
				type: 'agent_error',
				urgency: 'high',
				message: expectedText,
				metadata: { agentId: 'agent-dev-001' },
			}));
		});

		it('does not enqueue to the orchestrator queue when the orchestrator itself needs login', async () => {
			service.inspectScreen('crewly-orc', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();

			expect(service.getLoginRequired('crewly-orc')).toBeDefined();
			expect(mockQueue.enqueue).not.toHaveBeenCalled();
			expect(mockEventBus.publish).toHaveBeenCalled();
			expect(mockSlack.sendNotification).toHaveBeenCalled();
		});

		it('skips Slack when not connected', async () => {
			mockSlack.isConnected.mockReturnValue(false);
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			expect(mockSlack.sendNotification).not.toHaveBeenCalled();
		});

		it('does not re-notify for the same url/code within the cooldown', async () => {
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
			expect(mockSlack.sendNotification).toHaveBeenCalledTimes(1);
		});

		it('re-notifies when the device code changes', async () => {
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN.replace('FBVZ-MJHKK', 'QWER-TYUIO'), 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			expect(mockEventBus.publish).toHaveBeenCalledTimes(2);
			expect(service.getLoginRequired('agent-dev-001')?.code).toBe('QWER-TYUIO');
		});

		it('clears the flag once the screen moves past the login prompt', () => {
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			expect(service.getLoginRequired('agent-dev-001')).toBeDefined();
			service.inspectScreen('agent-dev-001', CODEX_IDLE_SCREEN, 'codex-cli');
			expect(service.getLoginRequired('agent-dev-001')).toBeUndefined();
		});

		it('survives a throwing sink without dropping the flag', async () => {
			mockQueue.enqueue.mockImplementation(() => { throw new Error('queue full'); });
			service.setSlackProvider(async () => { throw new Error('slack down'); });
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			expect(service.getLoginRequired('agent-dev-001')).toBeDefined();
			expect(mockEventBus.publish).toHaveBeenCalled();
		});

		it('formats a notice without url/code for the bare browser sign-in screen', async () => {
			service.inspectScreen('agent-dev-001', CODEX_BROWSER_SIGNIN_SCREEN, 'codex-cli');
			await Promise.resolve(); await Promise.resolve();
			expect(mockChat.broadcastSystemNotification).toHaveBeenCalledWith(
				'Agent agent-dev-001 needs you to sign in (open its terminal to complete login)',
				'warning',
			);
		});
	});

	describe('startMonitoring initial screen inspection', () => {
		it('flags a session whose sign-in screen was painted before monitoring began', () => {
			mockBackend.captureOutput.mockReturnValue(CODEX_DEVICE_CODE_SCREEN);
			service.startMonitoring('agent-dev-001', 'codex-cli');
			expect(mockBackend.captureOutput).toHaveBeenCalledWith('agent-dev-001', expect.any(Number));
			expect(service.getLoginRequired('agent-dev-001')?.code).toBe('FBVZ-MJHKK');
		});

		it('detects a sign-in screen that streams in during the startup grace period', () => {
			service.startMonitoring('agent-dev-001', 'codex-cli');
			mockBackend.captureOutput.mockReturnValue(CODEX_DEVICE_CODE_SCREEN);
			// Well inside STARTUP_GRACE_PERIOD_MS — expiry patterns are muted here, login must not be
			capturedOnDataCallback!('  1. Go to https://auth.openai.com/codex/device\n');
			expect(service.getLoginRequired('agent-dev-001')?.url).toBe('https://auth.openai.com/codex/device');
		});
	});

	describe('periodic sweep', () => {
		it('scans every live session and clears flags for sessions that are gone', () => {
			mockBackend.listSessions.mockReturnValue(['agent-a', 'agent-b']);
			mockBackend.captureOutput.mockImplementation((name: string) =>
				name === 'agent-a' ? CODEX_DEVICE_CODE_SCREEN : CODEX_IDLE_SCREEN
			);

			service.start(1000);
			jest.advanceTimersByTime(1000);

			expect(service.getLoginRequired('agent-a')?.code).toBe('FBVZ-MJHKK');
			expect(service.getLoginRequired('agent-b')).toBeUndefined();
			expect(service.getAllLoginRequired()).toHaveLength(1);

			// agent-a disappears
			mockBackend.listSessions.mockReturnValue(['agent-b']);
			jest.advanceTimersByTime(1000);
			expect(service.getLoginRequired('agent-a')).toBeUndefined();

			service.stop();
		});

		it('start() is idempotent and stop() halts the sweep', () => {
			mockBackend.listSessions.mockReturnValue(['agent-a']);
			mockBackend.captureOutput.mockReturnValue(CODEX_DEVICE_CODE_SCREEN);
			service.start(1000);
			service.start(1000);
			service.stop();
			jest.advanceTimersByTime(5000);
			expect(mockBackend.listSessions).not.toHaveBeenCalled();
		});
	});

	describe('submitOAuthCode clears the login-required flag', () => {
		it('drops the flag once a code is written to the session', () => {
			service.startMonitoring('agent-dev-001', 'codex-cli');
			service.inspectScreen('agent-dev-001', CODEX_DEVICE_CODE_SCREEN, 'codex-cli');
			expect(service.getLoginRequired('agent-dev-001')).toBeDefined();

			OAuthReloginMonitorService.submitOAuthCode('agent-dev-001', 'FBVZ-MJHKK');
			expect(service.getLoginRequired('agent-dev-001')).toBeUndefined();
		});
	});
});
