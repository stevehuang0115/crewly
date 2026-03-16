/**
 * Terminal Gateway Tests
 *
 * Tests for the WebSocket-based terminal streaming gateway.
 *
 * @module terminal-gateway.test
 */

import { TerminalGateway } from './terminal.gateway.js';
import { Server as SocketIOServer, Socket } from 'socket.io';

// Mock the session module
jest.mock('../services/session/index.js', () => ({
	getSessionBackend: jest.fn(),
	getSessionBackendSync: jest.fn(),
}));

// Mock InProcessLogBuffer
const mockLogBuffer = {
	hasSession: jest.fn(() => false),
	capture: jest.fn(() => '[crewly-agent] No output yet'),
	getSessionNames: jest.fn(() => []),
	on: jest.fn(),
	removeListener: jest.fn(),
};
jest.mock('../services/agent/crewly-agent/in-process-log-buffer.js', () => ({
	InProcessLogBuffer: {
		getInstance: jest.fn(() => mockLogBuffer),
	},
}));


// Mock the chat service (used for updateMessageMetadata when channelId present)
const mockUpdateMessageMetadata = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/chat/chat.service.js', () => ({
	getChatService: jest.fn(() => ({
		updateMessageMetadata: mockUpdateMessageMetadata,
	})),
}));

// Mock the logger service
jest.mock('../services/core/logger.service.js', () => ({
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

describe('TerminalGateway', () => {
	let gateway: TerminalGateway;
	let mockIo: Partial<SocketIOServer>;
	let mockSocket: Partial<Socket>;
	let mockSessionBackend: any;
	let mockSession: any;
	let connectionCallback: ((socket: Socket) => void) | null = null;

	beforeEach(() => {
		// Reset mocks
		jest.clearAllMocks();

		// Create mock socket
		mockSocket = {
			id: 'test-socket-id',
			emit: jest.fn(),
			join: jest.fn(),
			leave: jest.fn(),
			on: jest.fn(),
		};

		// Create mock Socket.IO server
		mockIo = {
			on: jest.fn((event: string, callback: (socket: Socket) => void) => {
				if (event === 'connection') {
					connectionCallback = callback;
				}
			}),
			to: jest.fn(() => ({
				emit: jest.fn(),
				disconnectSockets: jest.fn(),
			})),
			emit: jest.fn(),
			sockets: {
				sockets: new Map([['test-socket-id', mockSocket]]),
			},
		} as any;

		// Create mock session
		mockSession = {
			write: jest.fn(),
			resize: jest.fn(),
			onData: jest.fn(() => jest.fn()), // Returns unsubscribe function
			onExit: jest.fn(() => jest.fn()),
		};

		// Create mock session backend
		mockSessionBackend = {
			getSession: jest.fn(() => mockSession),
			sessionExists: jest.fn(() => true),
			captureOutput: jest.fn(() => 'mock output content'),
			getRawHistory: jest.fn(() => 'mock raw history with ANSI codes'),
			listSessions: jest.fn(() => ['test-session']),
		};

		// Set up the mock
		const { getSessionBackendSync } = require('../services/session/index.js');
		getSessionBackendSync.mockReturnValue(mockSessionBackend);

		// Create gateway
		gateway = new TerminalGateway(mockIo as SocketIOServer);
	});

	afterEach(() => {
		gateway.destroy();
		connectionCallback = null;
	});

	describe('constructor', () => {
		it('should set up connection handler', () => {
			expect(mockIo.on).toHaveBeenCalledWith('connection', expect.any(Function));
		});
	});

	describe('connection handling', () => {
		it('should emit connected message on new connection', () => {
			// Trigger the connection callback
			if (connectionCallback) {
				connectionCallback(mockSocket as Socket);
			}

			expect(mockSocket.emit).toHaveBeenCalledWith('connected', expect.objectContaining({
				type: 'connection_established',
				payload: { socketId: 'test-socket-id' },
			}));
		});

		it('should set up event handlers on connection', () => {
			if (connectionCallback) {
				connectionCallback(mockSocket as Socket);
			}

			expect(mockSocket.on).toHaveBeenCalledWith('subscribe_to_session', expect.any(Function));
			expect(mockSocket.on).toHaveBeenCalledWith('unsubscribe_from_session', expect.any(Function));
			expect(mockSocket.on).toHaveBeenCalledWith('send_input', expect.any(Function));
			expect(mockSocket.on).toHaveBeenCalledWith('terminal_resize', expect.any(Function));
			expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
		});
	});

	describe('subscribeToSession', () => {
		it('should add client to session room', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			expect(mockSocket.join).toHaveBeenCalledWith('terminal_test-session');
		});

		it('should confirm subscription', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			expect(mockSocket.emit).toHaveBeenCalledWith('subscription_confirmed', expect.objectContaining({
				type: 'subscription_confirmed',
				payload: { sessionName: 'test-session', sessionExists: true },
			}));
		});

		it('should start PTY streaming on first subscriber', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			expect(mockSessionBackend.getSession).toHaveBeenCalledWith('test-session');
			expect(mockSession.onData).toHaveBeenCalled();
		});

		it('should not duplicate PTY subscription for multiple clients', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			const mockSocket2 = {
				id: 'test-socket-id-2',
				emit: jest.fn(),
				join: jest.fn(),
				leave: jest.fn(),
			} as any;

			gateway.subscribeToSession('test-session', mockSocket2 as Socket);

			// onData should only be called once (first subscription)
			expect(mockSession.onData).toHaveBeenCalledTimes(1);
		});
	});

	describe('unsubscribeFromSession', () => {
		it('should remove client from session room', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);
			gateway.unsubscribeFromSession('test-session', mockSocket as Socket);

			expect(mockSocket.leave).toHaveBeenCalledWith('terminal_test-session');
		});

		it('should confirm unsubscription', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);
			gateway.unsubscribeFromSession('test-session', mockSocket as Socket);

			expect(mockSocket.emit).toHaveBeenCalledWith('unsubscription_confirmed', expect.objectContaining({
				type: 'unsubscription_confirmed',
				payload: { sessionName: 'test-session' },
			}));
		});
	});

	describe('sendInput', () => {
		it('should write input to PTY session', async () => {
			await gateway.sendInput('test-session', 'hello\r', mockSocket as Socket);

			expect(mockSession.write).toHaveBeenCalledWith('hello\r');
		});

		it('should emit error if session not found', async () => {
			mockSessionBackend.getSession.mockReturnValue(null);

			await gateway.sendInput('nonexistent-session', 'hello', mockSocket as Socket);

			expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
				type: 'session_not_found',
			}));
		});
	});

	describe('getConnectionStats', () => {
		it('should return connection statistics', () => {
			gateway.subscribeToSession('session1', mockSocket as Socket);

			const stats = gateway.getConnectionStats();

			expect(stats).toEqual({
				totalClients: 1,
				sessionSubscriptions: { session1: 1 },
				totalSessions: 1,
				activeStreams: 1,
			});
		});
	});

	describe('destroy', () => {
		it('should clean up all subscriptions', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);
			gateway.destroy();

			const stats = gateway.getConnectionStats();
			expect(stats.activeStreams).toBe(0);
			expect(stats.totalSessions).toBe(0);
		});
	});

	describe('activeConversationId', () => {
		it('should initially be null', () => {
			expect(gateway.getActiveConversationId()).toBeNull();
		});

		it('should set and get active conversation ID', () => {
			gateway.setActiveConversationId('test-conv-123');

			expect(gateway.getActiveConversationId()).toBe('test-conv-123');
		});

		it('should allow setting to null', () => {
			gateway.setActiveConversationId('test-conv-123');
			gateway.setActiveConversationId(null);

			expect(gateway.getActiveConversationId()).toBeNull();
		});

		it('should update to new conversation ID', () => {
			gateway.setActiveConversationId('conv-1');
			gateway.setActiveConversationId('conv-2');

			expect(gateway.getActiveConversationId()).toBe('conv-2');
		});
	});

	describe('disconnectSessionClients', () => {
		it('should disconnect all clients from session', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			gateway.disconnectSessionClients('test-session');

			expect(mockIo.to).toHaveBeenCalledWith('terminal_test-session');
		});

		it('should clean up session subscription after disconnect', () => {
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			gateway.disconnectSessionClients('test-session');

			const stats = gateway.getConnectionStats();
			expect(stats.totalSessions).toBe(0);
		});
	});

	describe('broadcast methods', () => {
		it('should broadcast system notification', () => {
			gateway.broadcastSystemNotification('Test message', 'info');

			expect(mockIo.emit).toHaveBeenCalledWith('system_notification', expect.objectContaining({
				type: 'system_notification',
				payload: { message: 'Test message', notificationType: 'info' },
			}));
		});

		it('should broadcast orchestrator status', () => {
			gateway.broadcastOrchestratorStatus({ status: 'active' });

			expect(mockIo.emit).toHaveBeenCalledWith('orchestrator_status_changed', expect.objectContaining({
				type: 'orchestrator_status_changed',
				payload: { status: 'active' },
			}));
		});

		it('should broadcast team member status', () => {
			gateway.broadcastTeamMemberStatus({ member: 'test-member', status: 'active' });

			expect(mockIo.emit).toHaveBeenCalledWith('team_member_status_changed', expect.objectContaining({
				type: 'team_member_status_changed',
				payload: { member: 'test-member', status: 'active' },
			}));
		});

		it('should broadcast team activity', () => {
			gateway.broadcastTeamActivity({ activity: 'test' });

			expect(mockIo.emit).toHaveBeenCalledWith('team_activity_updated', expect.objectContaining({
				type: 'team_activity_updated',
				payload: { activity: 'test' },
			}));
		});
	});


	describe('read-only mode', () => {
		it('should block input for read-only sessions', async () => {
			gateway.setReadOnly('test-session');

			await gateway.sendInput('test-session', 'hello\r', mockSocket as Socket);

			// Input should NOT be forwarded to PTY
			expect(mockSession.write).not.toHaveBeenCalled();
			// Should emit read_only error
			expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
				type: 'read_only',
				payload: expect.objectContaining({
					sessionName: 'test-session',
					error: expect.stringContaining('read-only'),
				}),
			}));
		});

		it('should allow input for non-read-only sessions', async () => {
			await gateway.sendInput('test-session', 'hello\r', mockSocket as Socket);

			expect(mockSession.write).toHaveBeenCalledWith('hello\r');
		});

		it('should restore input after clearing read-only mode', async () => {
			gateway.setReadOnly('test-session');
			gateway.clearReadOnly('test-session');

			await gateway.sendInput('test-session', 'hello\r', mockSocket as Socket);

			expect(mockSession.write).toHaveBeenCalledWith('hello\r');
		});

		it('should correctly report read-only status', () => {
			expect(gateway.isReadOnly('test-session')).toBe(false);

			gateway.setReadOnly('test-session');
			expect(gateway.isReadOnly('test-session')).toBe(true);

			gateway.clearReadOnly('test-session');
			expect(gateway.isReadOnly('test-session')).toBe(false);
		});

		it('should allow output streaming in read-only mode', () => {
			const onDataCallbacks: ((data: string) => void)[] = [];
			mockSession.onData.mockImplementation((cb: (data: string) => void) => {
				onDataCallbacks.push(cb);
				return jest.fn();
			});

			// Set read-only BEFORE subscribing
			gateway.setReadOnly('test-session');
			gateway.subscribeToSession('test-session', mockSocket as Socket);

			// Output streaming should still work
			expect(mockSession.onData).toHaveBeenCalled();
		});
	});

	describe('in-process session support', () => {
		beforeEach(() => {
			// PTY session does NOT exist — only in-process session
			mockSessionBackend.getSession.mockReturnValue(null);
			mockSessionBackend.sessionExists.mockReturnValue(false);
		});

		it('should subscribe to in-process session when PTY is not found', () => {
			mockLogBuffer.hasSession.mockReturnValue(true);
			mockLogBuffer.capture.mockReturnValue('[14:23:45.123] Agent initialized');

			gateway.subscribeToSession('agent-assistant', mockSocket as Socket);

			// Should confirm subscription with sessionExists: true
			expect(mockSocket.emit).toHaveBeenCalledWith('subscription_confirmed', expect.objectContaining({
				payload: { sessionName: 'agent-assistant', sessionExists: true },
			}));
		});

		it('should send initial state from InProcessLogBuffer for in-process sessions', () => {
			mockLogBuffer.hasSession.mockReturnValue(true);
			mockLogBuffer.capture.mockReturnValue('[14:23:45.123] Agent initialized\n[14:23:46.000] Ready');

			gateway.subscribeToSession('agent-assistant', mockSocket as Socket);

			// Should emit initial_terminal_state with log buffer content
			expect(mockSocket.emit).toHaveBeenCalledWith('initial_terminal_state', expect.objectContaining({
				type: 'initial_terminal_state',
				payload: expect.objectContaining({
					sessionName: 'agent-assistant',
					content: expect.stringContaining('Agent initialized'),
				}),
			}));
		});

		it('should auto-mark in-process sessions as read-only', () => {
			mockLogBuffer.hasSession.mockReturnValue(true);
			mockLogBuffer.capture.mockReturnValue('[crewly-agent] No output yet');

			gateway.subscribeToSession('agent-assistant', mockSocket as Socket);

			// In-process sessions should be read-only
			expect(gateway.isReadOnly('agent-assistant')).toBe(true);
		});

		it('should block input for in-process sessions', async () => {
			mockLogBuffer.hasSession.mockReturnValue(true);
			mockLogBuffer.capture.mockReturnValue('[crewly-agent] No output yet');

			gateway.subscribeToSession('agent-assistant', mockSocket as Socket);
			await gateway.sendInput('agent-assistant', 'hello\r', mockSocket as Socket);

			// Input should be blocked (read-only)
			expect(mockSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
				type: 'read_only',
			}));
		});

		it('should emit session_pending when neither PTY nor in-process exists', () => {
			mockLogBuffer.hasSession.mockReturnValue(false);

			gateway.subscribeToSession('nonexistent', mockSocket as Socket);

			expect(mockSocket.emit).toHaveBeenCalledWith('session_pending', expect.objectContaining({
				type: 'session_pending',
				payload: expect.objectContaining({ sessionName: 'nonexistent' }),
			}));
		});

		it('should detect in-process sessions via isInProcessSession', () => {
			mockLogBuffer.hasSession.mockReturnValue(true);
			expect(gateway.isInProcessSession('agent-assistant')).toBe(true);

			mockLogBuffer.hasSession.mockReturnValue(false);
			expect(gateway.isInProcessSession('pty-session')).toBe(false);
		});

		it('should register InProcessLogBuffer data event handler on construction', () => {
			expect(mockLogBuffer.on).toHaveBeenCalledWith('data', expect.any(Function));
		});

		it('should clean up InProcessLogBuffer listener on destroy', () => {
			gateway.destroy();

			expect(mockLogBuffer.removeListener).toHaveBeenCalledWith('data', expect.any(Function));
		});
	});
});
