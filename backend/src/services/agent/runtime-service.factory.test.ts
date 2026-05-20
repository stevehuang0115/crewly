import { RuntimeServiceFactory } from './runtime-service.factory.js';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { GeminiRuntimeService } from './gemini-runtime.service.js';
import { CodexRuntimeService } from './codex-runtime.service.js';
import { CrewlyAgentExternalRuntimeService } from './crewly-agent/crewly-agent-external-runtime.service.js';
import { RUNTIME_TYPES } from '../../constants.js';
import type { SessionCommandHelper } from '../session/index.js';

describe('RuntimeServiceFactory', () => {
	let mockSessionHelper: jest.Mocked<SessionCommandHelper>;
	const testProjectRoot = '/test/project';

	beforeEach(() => {
		// Create a mock SessionCommandHelper
		mockSessionHelper = {
			capturePane: jest.fn(),
			sendKey: jest.fn(),
			sendEnter: jest.fn(),
			sendMessage: jest.fn(),
			sendCtrlC: jest.fn(),
			sendEscape: jest.fn(),
			clearCurrentCommandLine: jest.fn(),
			sessionExists: jest.fn(),
			getSession: jest.fn(),
			listSessions: jest.fn(),
			killSession: jest.fn(),
			createSession: jest.fn(),
			setEnvironmentVariable: jest.fn(),
			resizeSession: jest.fn(),
			getBackend: jest.fn(),
		} as any;

		// Clear the instance cache before each test (this also nulls sessionHelperCache)
		RuntimeServiceFactory.clearCache();

		// Set the mock helper AFTER clearCache so it is not nulled out
		RuntimeServiceFactory.setSessionHelperForTesting(mockSessionHelper);
	});

	afterEach(() => {
		// Clear the instance cache and session helper after each test
		RuntimeServiceFactory.clearCache();
		RuntimeServiceFactory.setSessionHelperForTesting(null);
	});

	describe('create', () => {
		it('should create ClaudeRuntimeService for CLAUDE_CODE runtime type', () => {
			const service = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null, // Legacy param (ignored)
				testProjectRoot
			);

			expect(service).toBeInstanceOf(ClaudeRuntimeService);
		});

		it('should create GeminiRuntimeService for GEMINI_CLI runtime type', () => {
			const service = RuntimeServiceFactory.create(
				RUNTIME_TYPES.GEMINI_CLI,
				null,
				testProjectRoot
			);

			expect(service).toBeInstanceOf(GeminiRuntimeService);
		});

		it('should create CodexRuntimeService for CODEX_CLI runtime type', () => {
			const service = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CODEX_CLI,
				null,
				testProjectRoot
			);

			expect(service).toBeInstanceOf(CodexRuntimeService);
		});

		it('should create CrewlyAgentExternalRuntimeService for CREWLY_AGENT runtime type', () => {
			const service = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CREWLY_AGENT,
				null,
				testProjectRoot
			);

			expect(service).toBeInstanceOf(CrewlyAgentExternalRuntimeService);
		});

		it('should fallback to ClaudeRuntimeService for unknown runtime type', () => {
			const service = RuntimeServiceFactory.create(
				'unknown-runtime' as any,
				null,
				testProjectRoot
			);

			expect(service).toBeInstanceOf(ClaudeRuntimeService);
		});

		it('should return cached instance for same parameters', () => {
			const service1 = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				testProjectRoot
			);

			const service2 = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				testProjectRoot
			);

			expect(service1).toBe(service2);
		});

		it('should create separate instances for different project roots', () => {
			const service1 = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				'/project1'
			);

			const service2 = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				'/project2'
			);

			expect(service1).not.toBe(service2);
		});

		it('should create separate instances for different runtime types', () => {
			const claudeService = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				testProjectRoot
			);

			const geminiService = RuntimeServiceFactory.create(
				RUNTIME_TYPES.GEMINI_CLI,
				null,
				testProjectRoot
			);

			expect(claudeService).not.toBe(geminiService);
			expect(claudeService).toBeInstanceOf(ClaudeRuntimeService);
			expect(geminiService).toBeInstanceOf(GeminiRuntimeService);
		});

		it('should handle cache key generation correctly', () => {
			const service1 = RuntimeServiceFactory.create(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				testProjectRoot
			);

			// Cache should contain the entry
			const cacheKey = `${RUNTIME_TYPES.CLAUDE_CODE}-${testProjectRoot}`;
			expect(RuntimeServiceFactory.getCachedInstanceCount()).toBe(1);
		});
	});

	describe('createFresh', () => {
		it('should create a new instance without caching', () => {
			const service1 = RuntimeServiceFactory.createFresh(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				testProjectRoot
			);

			const service2 = RuntimeServiceFactory.createFresh(
				RUNTIME_TYPES.CLAUDE_CODE,
				null,
				testProjectRoot
			);

			// Should be different instances (not cached)
			expect(service1).not.toBe(service2);
			expect(service1).toBeInstanceOf(ClaudeRuntimeService);
			expect(service2).toBeInstanceOf(ClaudeRuntimeService);
		});

		it('should create correct runtime type without caching', () => {
			const gemini = RuntimeServiceFactory.createFresh(
				RUNTIME_TYPES.GEMINI_CLI,
				null,
				testProjectRoot
			);

			const codex = RuntimeServiceFactory.createFresh(
				RUNTIME_TYPES.CODEX_CLI,
				null,
				testProjectRoot
			);

			expect(gemini).toBeInstanceOf(GeminiRuntimeService);
			expect(codex).toBeInstanceOf(CodexRuntimeService);
		});
	});

	describe('createWithHelper', () => {
		it('should create service with explicit session helper', () => {
			const service = RuntimeServiceFactory.createWithHelper(
				RUNTIME_TYPES.CLAUDE_CODE,
				mockSessionHelper,
				testProjectRoot
			);

			expect(service).toBeInstanceOf(ClaudeRuntimeService);
		});
	});

	describe('getAvailableRuntimeTypes', () => {
		it('should return all supported runtime types', () => {
			const types = RuntimeServiceFactory.getAvailableRuntimeTypes();

			expect(types).toContain(RUNTIME_TYPES.CLAUDE_CODE);
			expect(types).toContain(RUNTIME_TYPES.GEMINI_CLI);
			expect(types).toContain(RUNTIME_TYPES.CODEX_CLI);
			expect(types).toContain(RUNTIME_TYPES.CREWLY_AGENT);
			expect(types).toHaveLength(4);
		});
	});

	describe('isRuntimeTypeSupported', () => {
		it('should return true for supported runtime types', () => {
			expect(RuntimeServiceFactory.isRuntimeTypeSupported(RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
			expect(RuntimeServiceFactory.isRuntimeTypeSupported(RUNTIME_TYPES.GEMINI_CLI)).toBe(true);
			expect(RuntimeServiceFactory.isRuntimeTypeSupported(RUNTIME_TYPES.CODEX_CLI)).toBe(true);
			expect(RuntimeServiceFactory.isRuntimeTypeSupported(RUNTIME_TYPES.CREWLY_AGENT)).toBe(true);
		});

		it('should return false for unsupported runtime types', () => {
			expect(RuntimeServiceFactory.isRuntimeTypeSupported('unknown-runtime')).toBe(false);
			expect(RuntimeServiceFactory.isRuntimeTypeSupported('chatgpt')).toBe(false);
		});
	});

	describe('clearCache', () => {
		it('should clear all cached instances', () => {
			RuntimeServiceFactory.create(RUNTIME_TYPES.CLAUDE_CODE, null, testProjectRoot);
			RuntimeServiceFactory.create(RUNTIME_TYPES.GEMINI_CLI, null, testProjectRoot);

			expect(RuntimeServiceFactory.getCachedInstanceCount()).toBe(2);

			// clearCache nulls sessionHelperCache, so re-set it after clearing
			RuntimeServiceFactory.clearCache();
			RuntimeServiceFactory.setSessionHelperForTesting(mockSessionHelper);

			expect(RuntimeServiceFactory.getCachedInstanceCount()).toBe(0);
		});
	});

	describe('clearCacheFor', () => {
		it('should clear cache for specific runtime and project', () => {
			RuntimeServiceFactory.create(RUNTIME_TYPES.CLAUDE_CODE, null, testProjectRoot);
			RuntimeServiceFactory.create(RUNTIME_TYPES.GEMINI_CLI, null, testProjectRoot);

			expect(RuntimeServiceFactory.getCachedInstanceCount()).toBe(2);

			RuntimeServiceFactory.clearCacheFor(RUNTIME_TYPES.CLAUDE_CODE, testProjectRoot);

			expect(RuntimeServiceFactory.getCachedInstanceCount()).toBe(1);
		});
	});
});
