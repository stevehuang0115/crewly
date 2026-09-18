/**
 * Session State Persistence Tests
 *
 * Tests for the session state persistence service.
 *
 * @module session-state-persistence.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import {
	SessionStatePersistence,
	getSessionStatePersistence,
	resetSessionStatePersistence,
	PersistedState,
	PersistedSessionInfo,
} from './session-state-persistence.js';
import type { ISessionBackend, SessionOptions } from './session-backend.interface.js';
import { RUNTIME_TYPES } from '../../constants.js';

// Mock the logger service
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn(() => ({
			createComponentLogger: jest.fn(() => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			})),
		})),
	},
}));

describe('SessionStatePersistence', () => {
	let persistence: SessionStatePersistence;
	let testFilePath: string;
	let mockBackend: jest.Mocked<ISessionBackend>;

	beforeEach(async () => {
		// Create a unique temp file for each test
		testFilePath = path.join(tmpdir(), `session-state-test-${Date.now()}.json`);
		persistence = new SessionStatePersistence(testFilePath);

		// Create mock backend
		mockBackend = {
			createSession: jest.fn(),
			getSession: jest.fn(),
			killSession: jest.fn(),
			listSessions: jest.fn(() => []),
			sessionExists: jest.fn(() => false),
			captureOutput: jest.fn(() => ''),
			getTerminalBuffer: jest.fn(() => ''),
			getRawHistory: jest.fn(() => ''),
			destroy: jest.fn(),
		} as unknown as jest.Mocked<ISessionBackend>;
	});

	afterEach(async () => {
		// Clean up test file
		try {
			await fs.unlink(testFilePath);
		} catch {
			// File might not exist
		}
		resetSessionStatePersistence();
	});

	describe('registerSession', () => {
		it('should register a session for persistence', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--dangerously-skip-permissions'],
			};

			persistence.registerSession('test-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev', 'team-1');

			expect(persistence.isSessionRegistered('test-session')).toBe(true);
			expect(persistence.getRegisteredSessions()).toContain('test-session');
		});

		it('should store session metadata correctly', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--resume'],
				env: { NODE_ENV: 'development' },
			};

			persistence.registerSession('test-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev', 'team-1');

			const metadata = persistence.getSessionMetadata('test-session');
			expect(metadata).toEqual({
				name: 'test-session',
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--resume'],
				runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
				role: 'dev',
				teamId: 'team-1',
				env: { NODE_ENV: 'development' },
			});
		});

		it('should store memberId when provided', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: [],
			};

			persistence.registerSession('member-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev', 'team-1', 'member-abc');

			const metadata = persistence.getSessionMetadata('member-session');
			expect(metadata?.memberId).toBe('member-abc');
			expect(metadata?.teamId).toBe('team-1');
		});

		it('should leave memberId undefined when not provided', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: [],
			};

			persistence.registerSession('no-member-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev', 'team-1');

			const metadata = persistence.getSessionMetadata('no-member-session');
			expect(metadata?.memberId).toBeUndefined();
		});

		it('keeps the recorded conversation id when the same session is registered again (every launch re-registers)', () => {
			const options: SessionOptions = { cwd: '/home/user/project', command: 'claude', args: [] };
			persistence.registerSession('agent-1', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			persistence.updateSessionId('agent-1', 'conv-123');
			persistence.registerSession('agent-1', { ...options, cwd: '/home/user/other' }, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			expect(persistence.getSessionId('agent-1')).toBe('conv-123');
			expect(persistence.getSessionMetadata('agent-1')?.cwd).toBe('/home/user/other');
			// A different runtime cannot resume the other runtime's conversation.
			persistence.registerSession('agent-1', options, RUNTIME_TYPES.CODEX_CLI, 'dev');
			expect(persistence.getSessionId('agent-1')).toBeUndefined();
		});
	});

	describe('forgetSessions', () => {
		it('drops only the named sessions and keeps the others with their conversation ids', async () => {
			const options: SessionOptions = { cwd: '/p', command: 'claude', args: [] };
			persistence.registerSession('alive', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			persistence.updateSessionId('alive', 'conv-alive');
			persistence.registerSession('dead', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			// (no file write needed — forgetSessions only touches metadata and removes the file)
			await persistence.forgetSessions(['dead']);
			expect(persistence.getRegisteredSessions()).toEqual(['alive']);
			expect(persistence.getSessionId('alive')).toBe('conv-alive');
		});
	});

	describe('unregisterSession', () => {
		it('should remove a session from persistence', () => {
			const options: SessionOptions = {
				cwd: '/home/user',
				command: 'claude',
			};

			persistence.registerSession('test-session', options, RUNTIME_TYPES.CLAUDE_CODE);
			expect(persistence.isSessionRegistered('test-session')).toBe(true);

			persistence.unregisterSession('test-session');
			expect(persistence.isSessionRegistered('test-session')).toBe(false);
		});

		it('should handle unregistering non-existent session gracefully', () => {
			expect(() => {
				persistence.unregisterSession('non-existent');
			}).not.toThrow();
		});
	});

	describe('saveState', () => {
		it('should save state to file', async () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--resume'],
			};

			persistence.registerSession('session1', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			persistence.registerSession('session2', options, RUNTIME_TYPES.GEMINI_CLI, 'qa');

			(mockBackend.listSessions as jest.Mock).mockReturnValue(['session1', 'session2']);

			const saved = await persistence.saveState(mockBackend);

			expect(saved).toBe(2);

			// Verify file contents
			const content = await fs.readFile(testFilePath, 'utf-8');
			const state: PersistedState = JSON.parse(content);

			expect(state.version).toBe(1);
			expect(state.sessions).toHaveLength(2);
			expect(state.sessions.map((s: PersistedSessionInfo) => s.name)).toContain('session1');
			expect(state.sessions.map((s: PersistedSessionInfo) => s.name)).toContain('session2');
		});

		it('should save all registered sessions regardless of backend state', async () => {
			const options: SessionOptions = {
				cwd: '/home/user',
				command: 'claude',
			};

			persistence.registerSession('session-a', options, RUNTIME_TYPES.CLAUDE_CODE);
			persistence.registerSession('session-b', options, RUNTIME_TYPES.CLAUDE_CODE);

			// Backend returns empty (simulates PTY processes already killed at shutdown)
			(mockBackend.listSessions as jest.Mock).mockReturnValue([]);

			const saved = await persistence.saveState(mockBackend);

			expect(saved).toBe(2);

			const state = await persistence.loadState();
			expect(state?.sessions).toHaveLength(2);
			expect(state?.sessions.map((s: PersistedSessionInfo) => s.name)).toContain('session-a');
			expect(state?.sessions.map((s: PersistedSessionInfo) => s.name)).toContain('session-b');
		});

		it('should create directory if it does not exist', async () => {
			const nestedPath = path.join(tmpdir(), 'nested', 'dir', `state-${Date.now()}.json`);
			const nestedPersistence = new SessionStatePersistence(nestedPath);

			const options: SessionOptions = {
				cwd: '/home/user',
				command: 'claude',
			};

			nestedPersistence.registerSession('test', options, RUNTIME_TYPES.CLAUDE_CODE);
			(mockBackend.listSessions as jest.Mock).mockReturnValue(['test']);

			await nestedPersistence.saveState(mockBackend);

			const content = await fs.readFile(nestedPath, 'utf-8');
			expect(JSON.parse(content).sessions).toHaveLength(1);

			// Clean up
			await fs.rm(path.join(tmpdir(), 'nested'), { recursive: true });
		});
	});

	describe('restoreState', () => {
		it('should restore sessions from saved state', async () => {
			// Create state file
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'restored-session',
						cwd: '/home/user/project',
						command: 'claude',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
						role: 'dev',
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			const restored = await persistence.restoreState(mockBackend);

			expect(restored).toBe(1);
			expect(mockBackend.createSession).toHaveBeenCalledWith('restored-session', {
				cwd: '/home/user/project',
				command: 'claude',
				args: [], // Args passed as-is; --resume not added since persisted command is the shell
				env: undefined,
			});
			expect(persistence.isSessionRegistered('restored-session')).toBe(true);
		});

		it('should not add --resume to shell args for Claude sessions', async () => {
			// The persisted command is the shell (e.g. /bin/zsh), not claude.
			// --resume should NOT be added since it would cause "zsh: no such option: resume".
			// Claude is launched inside the shell by initializeAgentWithRegistration.
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'claude-session',
						cwd: '/home/user',
						command: '/bin/zsh',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			await persistence.restoreState(mockBackend);

			const callArgs = (mockBackend.createSession as jest.Mock).mock.calls[0][1] as SessionOptions;
			expect(callArgs.args).not.toContain('--resume');
			expect(callArgs.args).toEqual([]);
		});

		it('should preserve original args for non-Claude sessions', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'gemini-session',
						cwd: '/home/user',
						command: 'gemini',
						args: ['--model', 'gemini-pro'],
						runtimeType: RUNTIME_TYPES.GEMINI_CLI,
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			await persistence.restoreState(mockBackend);

			const callArgs = (mockBackend.createSession as jest.Mock).mock.calls[0][1] as SessionOptions;
			expect(callArgs.args).not.toContain('--resume');
			expect(callArgs.args).toEqual(['--model', 'gemini-pro']);
		});

		it('should return 0 if no state file exists', async () => {
			const restored = await persistence.restoreState(mockBackend);

			expect(restored).toBe(0);
			expect(mockBackend.createSession).not.toHaveBeenCalled();
		});

		it('should skip unknown state versions', async () => {
			const state = {
				version: 999, // Unknown version
				savedAt: new Date().toISOString(),
				sessions: [{ name: 'test', cwd: '/', command: 'bash', args: [], runtimeType: 'claude-code' }],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			const restored = await persistence.restoreState(mockBackend);

			expect(restored).toBe(0);
			expect(mockBackend.createSession).not.toHaveBeenCalled();
		});

		it('should continue restoring other sessions if one fails', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{ name: 'session1', cwd: '/', command: 'claude', args: [], runtimeType: RUNTIME_TYPES.CLAUDE_CODE },
					{ name: 'session2', cwd: '/', command: 'claude', args: [], runtimeType: RUNTIME_TYPES.CLAUDE_CODE },
					{ name: 'session3', cwd: '/', command: 'claude', args: [], runtimeType: RUNTIME_TYPES.CLAUDE_CODE },
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			// First and third succeed, second fails
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const createSessionMock = mockBackend.createSession as jest.Mock<any>;
			createSessionMock
				.mockResolvedValueOnce({})
				.mockRejectedValueOnce(new Error('Failed'))
				.mockResolvedValueOnce({});

			const restored = await persistence.restoreState(mockBackend);

			expect(restored).toBe(2);
			expect(persistence.isSessionRegistered('session1')).toBe(true);
			expect(persistence.isSessionRegistered('session2')).toBe(false);
			expect(persistence.isSessionRegistered('session3')).toBe(true);
		});
	});

	describe('updateSessionId', () => {
		it('should update Claude session ID for a registered session', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: '/bin/zsh',
			};

			persistence.registerSession('test-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			persistence.updateSessionId('test-session', 'abc-123-def');

			expect(persistence.getSessionId('test-session')).toBe('abc-123-def');
		});

		it('should not throw for non-existent session', () => {
			expect(() => {
				persistence.updateSessionId('non-existent', 'abc-123');
			}).not.toThrow();

			expect(persistence.getSessionId('non-existent')).toBeUndefined();
		});

		it('should persist claudeSessionId through save/load cycle', async () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: '/bin/zsh',
			};

			persistence.registerSession('claude-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			persistence.updateSessionId('claude-session', 'session-uuid-456');

			(mockBackend.listSessions as jest.Mock).mockReturnValue(['claude-session']);
			await persistence.saveState(mockBackend);

			// Verify the saved state includes claudeSessionId
			const loaded = await persistence.loadState();
			expect(loaded?.sessions[0].claudeSessionId).toBe('session-uuid-456');
		});

		it('should persist memberId through save/load cycle', async () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: '/bin/zsh',
			};

			persistence.registerSession('member-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev', 'team-1', 'member-abc');

			(mockBackend.listSessions as jest.Mock).mockReturnValue(['member-session']);
			await persistence.saveState(mockBackend);

			const loaded = await persistence.loadState();
			expect(loaded?.sessions[0].memberId).toBe('member-abc');
		});

		it('should restore sessions with claudeSessionId metadata', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'resumable-session',
						cwd: '/home/user',
						command: '/bin/zsh',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
						role: 'dev',
						claudeSessionId: 'resume-this-id',
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			await persistence.restoreState(mockBackend);

			// After restore, the session metadata should include the claudeSessionId
			const metadata = persistence.getSessionMetadata('resumable-session');
			expect(metadata?.claudeSessionId).toBe('resume-this-id');
			expect(persistence.getSessionId('resumable-session')).toBe('resume-this-id');
		});
	});

	describe('getRegisteredSessionsMap', () => {
		it('should return a Map of all registered sessions', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: [],
			};

			persistence.registerSession('session-a', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev', 'team-1');
			persistence.registerSession('session-b', options, RUNTIME_TYPES.GEMINI_CLI, 'qa');

			const sessionsMap = persistence.getRegisteredSessionsMap();

			expect(sessionsMap).toBeInstanceOf(Map);
			expect(sessionsMap.size).toBe(2);
			expect(sessionsMap.get('session-a')?.role).toBe('dev');
			expect(sessionsMap.get('session-a')?.teamId).toBe('team-1');
			expect(sessionsMap.get('session-b')?.runtimeType).toBe(RUNTIME_TYPES.GEMINI_CLI);
		});

		it('should return a copy (mutations do not affect internal state)', () => {
			const options: SessionOptions = { cwd: '/', command: 'bash' };
			persistence.registerSession('test', options, RUNTIME_TYPES.CLAUDE_CODE);

			const map = persistence.getRegisteredSessionsMap();
			map.delete('test');

			// Internal state should be unaffected
			expect(persistence.isSessionRegistered('test')).toBe(true);
		});

		it('should return empty Map when no sessions registered', () => {
			const sessionsMap = persistence.getRegisteredSessionsMap();
			expect(sessionsMap.size).toBe(0);
		});
	});

	describe('clearStateAndMetadata', () => {
		it('should clear both in-memory metadata and state file', async () => {
			const options: SessionOptions = {
				cwd: '/home/user',
				command: 'claude',
			};

			persistence.registerSession('session1', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');
			persistence.registerSession('session2', options, RUNTIME_TYPES.GEMINI_CLI, 'qa');

			// Save state file
			(mockBackend.listSessions as jest.Mock).mockReturnValue(['session1', 'session2']);
			await persistence.saveState(mockBackend);

			// Verify data exists
			expect(persistence.getRegisteredSessions()).toHaveLength(2);
			const loadedBefore = await persistence.loadState();
			expect(loadedBefore?.sessions).toHaveLength(2);

			// Clear everything
			await persistence.clearStateAndMetadata();

			// Verify in-memory is cleared
			expect(persistence.getRegisteredSessions()).toHaveLength(0);

			// Verify state file is deleted
			const loadedAfter = await persistence.loadState();
			expect(loadedAfter).toBeNull();
		});

		it('should handle missing state file gracefully', async () => {
			const options: SessionOptions = { cwd: '/', command: 'bash' };
			persistence.registerSession('test', options, RUNTIME_TYPES.CLAUDE_CODE);

			// Don't save state file, but clear should still work
			await expect(persistence.clearStateAndMetadata()).resolves.not.toThrow();
			expect(persistence.getRegisteredSessions()).toHaveLength(0);
		});
	});

	describe('clearState', () => {
		it('should delete the state file', async () => {
			// Create state file
			await fs.writeFile(testFilePath, JSON.stringify({ version: 1, sessions: [] }));

			await persistence.clearState();

			await expect(fs.access(testFilePath)).rejects.toThrow();
		});

		it('should not throw if file does not exist', async () => {
			await expect(persistence.clearState()).resolves.not.toThrow();
		});
	});

	describe('clearMetadata', () => {
		it('should clear all registered sessions', () => {
			const options: SessionOptions = { cwd: '/', command: 'bash' };

			persistence.registerSession('session1', options, RUNTIME_TYPES.CLAUDE_CODE);
			persistence.registerSession('session2', options, RUNTIME_TYPES.GEMINI_CLI);

			expect(persistence.getRegisteredSessions()).toHaveLength(2);

			persistence.clearMetadata();

			expect(persistence.getRegisteredSessions()).toHaveLength(0);
		});
	});

	describe('isRestoredSession', () => {
		it('should return false before any restore', () => {
			expect(persistence.isRestoredSession('some-session')).toBe(false);
		});

		it('should return true for sessions restored from state file', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'restored-session',
						cwd: '/home/user/project',
						command: '/bin/zsh',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
						role: 'dev',
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));
			await persistence.restoreState(mockBackend);

			expect(persistence.isRestoredSession('restored-session')).toBe(true);
		});

		it('should return false for newly registered sessions', () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: '/bin/zsh',
			};

			persistence.registerSession('new-session', options, RUNTIME_TYPES.CLAUDE_CODE);

			expect(persistence.isRestoredSession('new-session')).toBe(false);
		});

		it('should be cleared by clearStateAndMetadata', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'restored-session',
						cwd: '/home/user',
						command: '/bin/zsh',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));
			await persistence.restoreState(mockBackend);
			expect(persistence.isRestoredSession('restored-session')).toBe(true);

			await persistence.clearStateAndMetadata();
			expect(persistence.isRestoredSession('restored-session')).toBe(false);
		});

		it('should be cleared by clearMetadata', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: new Date().toISOString(),
				sessions: [
					{
						name: 'restored-session',
						cwd: '/home/user',
						command: '/bin/zsh',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));
			await persistence.restoreState(mockBackend);
			expect(persistence.isRestoredSession('restored-session')).toBe(true);

			persistence.clearMetadata();
			expect(persistence.isRestoredSession('restored-session')).toBe(false);
		});
	});

	describe('autoSave', () => {
		it('should auto-save to disk when registerSession is called', async () => {
			const options: SessionOptions = {
				cwd: '/home/user/project',
				command: 'claude',
				args: ['--flag'],
			};

			persistence.registerSession('auto-saved-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');

			// Wait for fire-and-forget autoSave to complete
			await new Promise(resolve => setTimeout(resolve, 100));

			const state = await persistence.loadState();
			expect(state).not.toBeNull();
			expect(state?.sessions).toHaveLength(1);
			expect(state?.sessions[0].name).toBe('auto-saved-session');
		});

		it('should auto-save to disk when unregisterSession is called', async () => {
			const options: SessionOptions = {
				cwd: '/home/user',
				command: 'claude',
			};

			persistence.registerSession('session-to-remove', options, RUNTIME_TYPES.CLAUDE_CODE);
			persistence.registerSession('session-to-keep', options, RUNTIME_TYPES.CLAUDE_CODE);

			// Wait for register auto-saves
			await new Promise(resolve => setTimeout(resolve, 100));

			persistence.unregisterSession('session-to-remove');

			// Wait for unregister auto-save
			await new Promise(resolve => setTimeout(resolve, 100));

			const state = await persistence.loadState();
			expect(state).not.toBeNull();
			expect(state?.sessions).toHaveLength(1);
			expect(state?.sessions[0].name).toBe('session-to-keep');
		});

		it('should auto-save to disk when updateSessionId is called', async () => {
			const options: SessionOptions = {
				cwd: '/home/user',
				command: '/bin/zsh',
			};

			persistence.registerSession('claude-session', options, RUNTIME_TYPES.CLAUDE_CODE, 'dev');

			// Wait for register auto-save
			await new Promise(resolve => setTimeout(resolve, 100));

			persistence.updateSessionId('claude-session', 'session-uuid-789');

			// Wait for updateSessionId auto-save
			await new Promise(resolve => setTimeout(resolve, 100));

			const state = await persistence.loadState();
			expect(state).not.toBeNull();
			expect(state?.sessions[0].claudeSessionId).toBe('session-uuid-789');
		});
	});

	describe('loadState', () => {
		it('should load state from file', async () => {
			const state: PersistedState = {
				version: 1,
				savedAt: '2024-01-01T00:00:00.000Z',
				sessions: [
					{
						name: 'test-session',
						cwd: '/home/user',
						command: 'claude',
						args: [],
						runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
					},
				],
			};

			await fs.writeFile(testFilePath, JSON.stringify(state));

			const loaded = await persistence.loadState();

			expect(loaded).toEqual(state);
		});

		it('should return null for non-existent file', async () => {
			const loaded = await persistence.loadState();

			expect(loaded).toBeNull();
		});

		it('should return null for invalid JSON', async () => {
			await fs.writeFile(testFilePath, 'not valid json');

			const loaded = await persistence.loadState();

			expect(loaded).toBeNull();
		});
	});

	describe('singleton', () => {
		it('should return same instance', () => {
			resetSessionStatePersistence();

			const instance1 = getSessionStatePersistence();
			const instance2 = getSessionStatePersistence();

			expect(instance1).toBe(instance2);
		});

		it('should create new instance after reset', () => {
			const instance1 = getSessionStatePersistence();
			resetSessionStatePersistence();
			const instance2 = getSessionStatePersistence();

			expect(instance1).not.toBe(instance2);
		});
	});

	describe('getFilePath', () => {
		it('should return the state file path', () => {
			expect(persistence.getFilePath()).toBe(testFilePath);
		});
	});
});
