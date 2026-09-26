/**
 * Tests for the Runtime Adapter Layer.
 *
 * Validates the RuntimeAdapter interface, concrete adapters (ClaudeCodeAdapter,
 * GeminiCliAdapter, CodexAdapter), factory function, and utility helpers.
 */

import { RUNTIME_TYPES } from '../constants.js';
import type { SessionCommandHelper } from './session/index.js';
import type { ISessionBackend } from './session/index.js';
import type { RuntimeAgentService } from './agent/runtime-agent.service.abstract.js';
import {
	ClaudeCodeAdapter,
	GeminiCliAdapter,
	CodexAdapter,
	OpenCodeAdapter,
	AntigravityCliAdapter,
	getRuntimeAdapter,
	getSupportedRuntimeTypes,
	isSupportedRuntime,
	type RuntimeAdapter,
	type RuntimeAdapterConfig,
} from './runtime-adapter.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('./session/index.js', () => ({
	getSessionBackendSync: jest.fn(),
	createSessionCommandHelper: jest.fn(),
}));

jest.mock('./agent/runtime-service.factory.js', () => ({
	RuntimeServiceFactory: {
		createWithHelper: jest.fn(),
		getAvailableRuntimeTypes: jest.fn(() => [
			'claude-code',
			'gemini-cli',
			'codex-cli',
			'opencode-cli',
			'antigravity-cli',
			'crewly-agent',
		]),
		isRuntimeTypeSupported: jest.fn((type: string) =>
			['claude-code', 'gemini-cli', 'codex-cli', 'opencode-cli', 'antigravity-cli', 'crewly-agent'].includes(type),
		),
	},
}));

import { getSessionBackendSync, createSessionCommandHelper } from './session/index.js';
import { RuntimeServiceFactory } from './agent/runtime-service.factory.js';

const mockGetBackend = getSessionBackendSync as jest.MockedFunction<typeof getSessionBackendSync>;
const mockCreateHelper = createSessionCommandHelper as jest.MockedFunction<typeof createSessionCommandHelper>;
const mockFactoryCreate = RuntimeServiceFactory.createWithHelper as jest.MockedFunction<typeof RuntimeServiceFactory.createWithHelper>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockBackend(): jest.Mocked<ISessionBackend> {
	return {
		createSession: jest.fn().mockResolvedValue({
			name: 'test-session',
			pid: 1234,
			cwd: '/test',
			onData: jest.fn(),
			onExit: jest.fn(),
			write: jest.fn(),
			resize: jest.fn(),
			kill: jest.fn(),
		}),
		getSession: jest.fn(),
		killSession: jest.fn().mockResolvedValue(undefined),
		listSessions: jest.fn().mockReturnValue([]),
		sessionExists: jest.fn().mockReturnValue(false),
		captureOutput: jest.fn().mockReturnValue(''),
		getTerminalBuffer: jest.fn().mockReturnValue(''),
		getRawHistory: jest.fn().mockReturnValue(''),
		destroy: jest.fn().mockResolvedValue(undefined),
	};
}

function createMockSessionHelper(): jest.Mocked<SessionCommandHelper> {
	return {
		capturePane: jest.fn().mockReturnValue('terminal output'),
		sendKey: jest.fn().mockResolvedValue(undefined),
		sendEnter: jest.fn().mockResolvedValue(undefined),
		sendMessage: jest.fn().mockResolvedValue(undefined),
		sendCtrlC: jest.fn().mockResolvedValue(undefined),
		sendEscape: jest.fn().mockResolvedValue(undefined),
		clearCurrentCommandLine: jest.fn().mockResolvedValue(undefined),
		sessionExists: jest.fn().mockReturnValue(true),
		getSession: jest.fn(),
		listSessions: jest.fn().mockReturnValue([]),
		killSession: jest.fn().mockResolvedValue(undefined),
		createSession: jest.fn().mockResolvedValue(undefined),
		setEnvironmentVariable: jest.fn().mockResolvedValue(undefined),
		resizeSession: jest.fn(),
		getBackend: jest.fn(),
	} as any;
}

function createMockRuntimeService(): jest.Mocked<RuntimeAgentService> {
	return {
		executeRuntimeInitScript: jest.fn().mockResolvedValue(undefined),
		detectRuntimeWithCommand: jest.fn().mockResolvedValue(true),
		waitForRuntimeReady: jest.fn().mockResolvedValue(true),
		postInitialize: jest.fn().mockResolvedValue(undefined),
		clearDetectionCache: jest.fn(),
		getRuntimeConfiguration: jest.fn().mockReturnValue(null),
		getExitPatterns: jest.fn().mockReturnValue([]),
	} as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeAdapter', () => {
	let mockBackend: jest.Mocked<ISessionBackend>;
	let mockHelper: jest.Mocked<SessionCommandHelper>;
	let mockRuntimeService: jest.Mocked<RuntimeAgentService>;

	const testConfig: RuntimeAdapterConfig = {
		sessionName: 'test-agent',
		projectPath: '/test/project',
		runtimeFlags: ['--chrome'],
		promptFilePath: '/tmp/prompt.md',
		env: { CREWLY_SESSION_NAME: 'test-agent' },
	};

	beforeEach(() => {
		mockBackend = createMockBackend();
		mockHelper = createMockSessionHelper();
		mockRuntimeService = createMockRuntimeService();
		jest.clearAllMocks();
	});

	// -----------------------------------------------------------------------
	// ClaudeCodeAdapter
	// -----------------------------------------------------------------------

	describe('ClaudeCodeAdapter', () => {
		let adapter: ClaudeCodeAdapter;

		beforeEach(() => {
			adapter = new ClaudeCodeAdapter(mockBackend, mockHelper, mockRuntimeService);
		});

		it('has correct runtimeType and displayName', () => {
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.CLAUDE_CODE);
			expect(adapter.displayName).toBe('Claude Code');
		});

		describe('start', () => {
			it('creates session, sets env, runs init script, and post-initializes', async () => {
				await adapter.start(testConfig);

				expect(mockHelper.createSession).toHaveBeenCalledWith(
					'test-agent',
					'/test/project',
				);
				expect(mockHelper.setEnvironmentVariable).toHaveBeenCalledWith(
					'test-agent',
					'CREWLY_SESSION_NAME',
					'test-agent',
				);
				expect(mockRuntimeService.executeRuntimeInitScript).toHaveBeenCalledWith(
					'test-agent',
					'/test/project',
					['--chrome'],
					'/tmp/prompt.md',
				);
				expect(mockRuntimeService.postInitialize).toHaveBeenCalledWith(
					'test-agent',
					'/test/project',
				);
			});

			it('skips env vars when none provided', async () => {
				await adapter.start({
					sessionName: 'agent-1',
					projectPath: '/project',
				});

				expect(mockHelper.setEnvironmentVariable).not.toHaveBeenCalled();
				expect(mockHelper.createSession).toHaveBeenCalled();
			});
		});

		describe('stop', () => {
			it('kills the session via backend', async () => {
				await adapter.stop('test-agent');

				expect(mockBackend.killSession).toHaveBeenCalledWith('test-agent');
			});
		});

		describe('write', () => {
			it('sends message via session helper', async () => {
				await adapter.write('test-agent', 'Hello, build a REST API');

				expect(mockHelper.sendMessage).toHaveBeenCalledWith(
					'test-agent',
					'Hello, build a REST API',
				);
			});
		});

		describe('getOutput', () => {
			it('captures terminal output', async () => {
				const output = await adapter.getOutput('test-agent');

				expect(output).toBe('terminal output');
				expect(mockHelper.capturePane).toHaveBeenCalledWith('test-agent', undefined);
			});

			it('passes line count parameter', async () => {
				await adapter.getOutput('test-agent', 100);

				expect(mockHelper.capturePane).toHaveBeenCalledWith('test-agent', 100);
			});
		});

		describe('isRunning', () => {
			it('returns true when session exists', () => {
				mockBackend.sessionExists.mockReturnValue(true);

				expect(adapter.isRunning('test-agent')).toBe(true);
				expect(mockBackend.sessionExists).toHaveBeenCalledWith('test-agent');
			});

			it('returns false when session does not exist', () => {
				mockBackend.sessionExists.mockReturnValue(false);

				expect(adapter.isRunning('test-agent')).toBe(false);
			});
		});

		describe('waitForReady', () => {
			it('delegates to runtime service', async () => {
				const result = await adapter.waitForReady('test-agent', 30000);

				expect(result).toBe(true);
				expect(mockRuntimeService.waitForRuntimeReady).toHaveBeenCalledWith(
					'test-agent',
					30000,
				);
			});

			it('uses default timeout of 60000ms', async () => {
				await adapter.waitForReady('test-agent');

				expect(mockRuntimeService.waitForRuntimeReady).toHaveBeenCalledWith(
					'test-agent',
					60000,
				);
			});
		});

		describe('detectRuntime', () => {
			it('delegates to runtime service with force refresh', async () => {
				const result = await adapter.detectRuntime('test-agent');

				expect(result).toBe(true);
				expect(mockRuntimeService.detectRuntimeWithCommand).toHaveBeenCalledWith(
					'test-agent',
					true,
				);
			});
		});

		describe('compact', () => {
			it('sends /compact command to session', async () => {
				const mockSession = {
					write: jest.fn(),
					onData: jest.fn(),
					onExit: jest.fn(),
				};
				mockBackend.sessionExists.mockReturnValue(true);
				mockBackend.getSession.mockReturnValue(mockSession as any);

				const result = await adapter.compact('test-agent');

				expect(result).toBe(true);
				expect(mockSession.write).toHaveBeenCalledWith('/compact\r');
			});

			it('returns false when session does not exist', async () => {
				mockBackend.sessionExists.mockReturnValue(false);

				const result = await adapter.compact('test-agent');

				expect(result).toBe(false);
			});

			it('returns false when session is null', async () => {
				mockBackend.sessionExists.mockReturnValue(true);
				mockBackend.getSession.mockReturnValue(undefined);

				const result = await adapter.compact('test-agent');

				expect(result).toBe(false);
			});
		});
	});

	// -----------------------------------------------------------------------
	// GeminiCliAdapter
	// -----------------------------------------------------------------------

	describe('GeminiCliAdapter', () => {
		let adapter: GeminiCliAdapter;

		beforeEach(() => {
			adapter = new GeminiCliAdapter(mockBackend, mockHelper, mockRuntimeService);
		});

		it('has correct runtimeType and displayName', () => {
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.GEMINI_CLI);
			expect(adapter.displayName).toBe('Gemini CLI');
		});

		it('supports the full adapter interface', async () => {
			await adapter.start({ sessionName: 's1', projectPath: '/p' });
			expect(mockHelper.createSession).toHaveBeenCalled();

			await adapter.stop('s1');
			expect(mockBackend.killSession).toHaveBeenCalled();

			await adapter.write('s1', 'hello');
			expect(mockHelper.sendMessage).toHaveBeenCalled();

			const output = await adapter.getOutput('s1');
			expect(typeof output).toBe('string');

			expect(typeof adapter.isRunning('s1')).toBe('boolean');
		});

		it('sends /compress command for compact', async () => {
			const mockSession = {
				write: jest.fn(),
				onData: jest.fn(),
				onExit: jest.fn(),
			};
			mockBackend.sessionExists.mockReturnValue(true);
			mockBackend.getSession.mockReturnValue(mockSession as any);

			const result = await adapter.compact('s1');

			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('/compress\r');
		});
	});

	// -----------------------------------------------------------------------
	// CodexAdapter
	// -----------------------------------------------------------------------

	describe('CodexAdapter', () => {
		let adapter: CodexAdapter;

		beforeEach(() => {
			adapter = new CodexAdapter(mockBackend, mockHelper, mockRuntimeService);
		});

		it('has correct runtimeType and displayName', () => {
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.CODEX_CLI);
			expect(adapter.displayName).toBe('OpenAI Codex');
		});

		it('supports the full adapter interface', async () => {
			await adapter.start({ sessionName: 's1', projectPath: '/p' });
			expect(mockHelper.createSession).toHaveBeenCalled();

			await adapter.stop('s1');
			expect(mockBackend.killSession).toHaveBeenCalled();

			await adapter.write('s1', 'hello');
			expect(mockHelper.sendMessage).toHaveBeenCalled();

			const output = await adapter.getOutput('s1');
			expect(typeof output).toBe('string');
		});

		it('sends /compact command for compact', async () => {
			const mockSession = {
				write: jest.fn(),
				onData: jest.fn(),
				onExit: jest.fn(),
			};
			mockBackend.sessionExists.mockReturnValue(true);
			mockBackend.getSession.mockReturnValue(mockSession as any);

			const result = await adapter.compact('s1');

			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('/compact\r');
		});
	});

	// -----------------------------------------------------------------------
	// getRuntimeAdapter factory
	// -----------------------------------------------------------------------

	describe('getRuntimeAdapter', () => {
		beforeEach(() => {
			mockGetBackend.mockReturnValue(mockBackend);
			mockCreateHelper.mockReturnValue(mockHelper);
			mockFactoryCreate.mockReturnValue(mockRuntimeService);
		});

		it('returns ClaudeCodeAdapter for claude-code', () => {
			const adapter = getRuntimeAdapter(RUNTIME_TYPES.CLAUDE_CODE, '/project');

			expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.CLAUDE_CODE);
		});

		it('returns GeminiCliAdapter for gemini-cli', () => {
			const adapter = getRuntimeAdapter(RUNTIME_TYPES.GEMINI_CLI, '/project');

			expect(adapter).toBeInstanceOf(GeminiCliAdapter);
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.GEMINI_CLI);
		});

		it('returns CodexAdapter for codex-cli', () => {
			const adapter = getRuntimeAdapter(RUNTIME_TYPES.CODEX_CLI, '/project');

			expect(adapter).toBeInstanceOf(CodexAdapter);
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.CODEX_CLI);
		});

		it('returns OpenCodeAdapter for opencode-cli (#306)', () => {
			const adapter = getRuntimeAdapter(RUNTIME_TYPES.OPENCODE_CLI, '/project');

			expect(adapter).toBeInstanceOf(OpenCodeAdapter);
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.OPENCODE_CLI);
			expect(adapter.displayName).toBe('OpenCode');
		});

		it('returns AntigravityCliAdapter for antigravity-cli', () => {
			const adapter = getRuntimeAdapter(RUNTIME_TYPES.ANTIGRAVITY_CLI, '/project');

			expect(adapter).toBeInstanceOf(AntigravityCliAdapter);
			expect(adapter.runtimeType).toBe(RUNTIME_TYPES.ANTIGRAVITY_CLI);
			expect(adapter.displayName).toBe('Antigravity CLI');
		});

		it('falls back to ClaudeCodeAdapter for unknown runtime', () => {
			const adapter = getRuntimeAdapter('unknown' as any, '/project');

			expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
		});

		it('throws when session backend is not initialized', () => {
			mockGetBackend.mockReturnValue(null);

			expect(() => getRuntimeAdapter(RUNTIME_TYPES.CLAUDE_CODE, '/project')).toThrow(
				'Session backend not initialized',
			);
		});

		it('passes correct arguments to RuntimeServiceFactory', () => {
			getRuntimeAdapter(RUNTIME_TYPES.GEMINI_CLI, '/my/project');

			expect(mockFactoryCreate).toHaveBeenCalledWith(
				RUNTIME_TYPES.GEMINI_CLI,
				expect.anything(), // sessionHelper
				'/my/project',
			);
		});
	});

	// -----------------------------------------------------------------------
	// Utility functions
	// -----------------------------------------------------------------------

	describe('getSupportedRuntimeTypes', () => {
		it('returns all supported runtime types', () => {
			const types = getSupportedRuntimeTypes();

			expect(types).toContain('claude-code');
			expect(types).toContain('gemini-cli');
			expect(types).toContain('codex-cli');
			expect(types).toContain('opencode-cli');
			expect(types).toContain('antigravity-cli');
			expect(types).toContain('crewly-agent');
			expect(types).toHaveLength(6);
		});
	});

	describe('isSupportedRuntime', () => {
		it('returns true for supported runtimes', () => {
			expect(isSupportedRuntime('claude-code')).toBe(true);
			expect(isSupportedRuntime('gemini-cli')).toBe(true);
			expect(isSupportedRuntime('codex-cli')).toBe(true);
		});

		it('returns false for unsupported runtimes', () => {
			expect(isSupportedRuntime('chatgpt')).toBe(false);
			expect(isSupportedRuntime('')).toBe(false);
		});
	});
});
