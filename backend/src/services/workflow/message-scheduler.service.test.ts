import { MessageSchedulerService } from './message-scheduler.service';
import { TmuxService } from '../agent/tmux.service.js';
import { AgentRegistrationService } from '../agent/agent-registration.service.js';
import { StorageService } from '../core/storage.service.js';
import { ScheduledMessage, MessageDeliveryLog } from '../../types/index';
import { MessageDeliveryLogModel } from '../../models/ScheduledMessage';
import { CREWLY_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

// Mock dependencies
const mockNoteSystemTurn = jest.fn();
jest.mock('../people/acting-for.service.js', () => ({ noteSystemTurn: (...args: unknown[]) => mockNoteSystemTurn(...args) }));
jest.mock('../agent/tmux.service.js');
jest.mock('../agent/agent-registration.service.js');
jest.mock('../core/storage.service.js');
jest.mock('../../models/ScheduledMessage');
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn(),
	},
}));
// SessionCommandHelper uses delay internally - mock it so tests don't hang
jest.mock('../../utils/async.utils.js', () => ({
	delay: jest.fn().mockResolvedValue(undefined),
}));

describe('MessageSchedulerService', () => {
	let service: MessageSchedulerService;
	let mockTmuxService: jest.Mocked<TmuxService>;
	let mockStorageService: jest.Mocked<StorageService>;
	let mockAgentRegistrationService: { sendMessageToAgent: jest.Mock };
	let mockLoggerInfo: jest.Mock;
	let mockLoggerError: jest.Mock;
	let mockLoggerWarn: jest.Mock;
	let mockLoggerDebug: jest.Mock;

	const mockScheduledMessage: ScheduledMessage = {
		id: 'test-message-1',
		name: 'Test Message',
		targetTeam: 'test-team',
		targetProject: 'test-project',
		message: 'Hello World',
		delayAmount: 5,
		delayUnit: 'minutes',
		isRecurring: false,
		isActive: true,
		createdAt: '2023-01-01T00:00:00.000Z',
		updatedAt: '2023-01-01T00:00:00.000Z',
	};

	const mockDeliveryLog: MessageDeliveryLog = {
		id: 'log-1',
		scheduledMessageId: 'test-message-1',
		messageName: 'Test Message',
		targetTeam: 'test-team',
		targetProject: 'test-project',
		message: 'Hello World',
		sentAt: '2023-01-01T00:05:00.000Z',
		success: true,
	};

	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();

		// Set up mock logger (must be before service construction)
		mockLoggerInfo = jest.fn();
		mockLoggerError = jest.fn();
		mockLoggerWarn = jest.fn();
		mockLoggerDebug = jest.fn();
		(LoggerService.getInstance as jest.Mock).mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: mockLoggerInfo,
				error: mockLoggerError,
				warn: mockLoggerWarn,
				debug: mockLoggerDebug,
			}),
		});

		mockTmuxService = {
			sessionExists: jest.fn(),
			sendMessage: jest.fn(),
		} as any;

		mockStorageService = {
			getScheduledMessages: jest.fn(),
			saveScheduledMessage: jest.fn(),
			saveDeliveryLog: jest.fn(),
			getProjects: jest.fn(),
			findMemberBySessionName: jest.fn().mockResolvedValue(null),
		} as any;

		// Mock AgentRegistrationService for reliable delivery
		mockAgentRegistrationService = {
			sendMessageToAgent: jest.fn().mockResolvedValue({ success: true, message: 'Delivered' }),
		};

		(MessageDeliveryLogModel.create as jest.Mock).mockReturnValue(mockDeliveryLog);

		service = new MessageSchedulerService(mockTmuxService, mockStorageService);
		service.setAgentRegistrationService(mockAgentRegistrationService as any);
	});

	afterEach(() => {
		jest.useRealTimers();
		service.cleanup();
	});

	describe('constructor', () => {
		it('should initialize with required services', () => {
			expect(service).toBeInstanceOf(MessageSchedulerService);
		});
	});

	describe('setAgentRegistrationService', () => {
		it('should accept and store the agent registration service', () => {
			const freshService = new MessageSchedulerService(mockTmuxService, mockStorageService);
			freshService.setAgentRegistrationService(mockAgentRegistrationService as any);

			// Verify it's wired by exercising executeMessage (internal field)
			expect((freshService as any).agentRegistrationService).toBe(mockAgentRegistrationService);
		});
	});

	describe('start', () => {
		it('should start scheduler and load messages', async () => {
			mockStorageService.getScheduledMessages.mockResolvedValue([mockScheduledMessage]);
			const scheduleMessageSpy = jest.spyOn(service, 'scheduleMessage').mockImplementation();

			await service.start();

			expect(mockLoggerInfo).toHaveBeenCalledWith('Starting message scheduler service...');
			expect(mockLoggerInfo).toHaveBeenCalledWith('Message scheduler service started');
			expect(mockStorageService.getScheduledMessages).toHaveBeenCalled();
			expect(scheduleMessageSpy).toHaveBeenCalledWith(mockScheduledMessage);
		});

		it('should handle error during message loading', async () => {
			mockStorageService.getScheduledMessages.mockRejectedValue(new Error('Storage error'));

			await service.start();

			expect(mockLoggerError).toHaveBeenCalledWith(
				'Error loading scheduled messages',
				expect.objectContaining({ error: 'Storage error' }),
			);
		});
	});

	describe('scheduleMessage', () => {
		it('should not schedule inactive messages', () => {
			const inactiveMessage = { ...mockScheduledMessage, isActive: false };
			const cancelMessageSpy = jest.spyOn(service, 'cancelMessage').mockImplementation();

			service.scheduleMessage(inactiveMessage);

			expect(cancelMessageSpy).not.toHaveBeenCalled();
			expect(service.getStats().activeSchedules).toBe(0);
		});

		it('should schedule one-time message', () => {
			service.scheduleMessage(mockScheduledMessage);

			expect(service.getStats().activeSchedules).toBe(1);
			expect(service.getStats().scheduledMessageIds).toContain('test-message-1');
			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Scheduled message',
				expect.objectContaining({
					name: 'Test Message',
					delay: '5 minutes',
					recurring: false,
				}),
			);
		});

		it('should schedule recurring message', () => {
			const recurringMessage = { ...mockScheduledMessage, isRecurring: true };

			service.scheduleMessage(recurringMessage);

			expect(service.getStats().activeSchedules).toBe(1);
			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Scheduled message',
				expect.objectContaining({
					name: 'Test Message',
					delay: '5 minutes',
					recurring: true,
				}),
			);
		});

		it('should cancel existing message before scheduling', () => {
			const cancelMessageSpy = jest.spyOn(service, 'cancelMessage').mockImplementation();

			service.scheduleMessage(mockScheduledMessage);

			expect(cancelMessageSpy).toHaveBeenCalledWith('test-message-1');
		});

		it('should execute message after delay via sendMessageToAgent', async () => {
			mockStorageService.saveDeliveryLog.mockResolvedValue(undefined);
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);
			mockStorageService.getProjects.mockResolvedValue([{ id: 'test-project', name: 'Test' }] as any);

			service.scheduleMessage(mockScheduledMessage);

			// Fast forward past the delay (5 minutes = 300000ms)
			jest.advanceTimersByTime(300000);

			// Wait for async operations (queue delay uses raw setTimeout)
			await jest.runAllTimersAsync();

			// Verify sendMessageToAgent was called with enhanced message
			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-team',
				expect.stringContaining('Hello World'),
				expect.any(String), // runtimeType
			);
			expect(mockStorageService.saveDeliveryLog).toHaveBeenCalled();
			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalled();
			// Issue #968: a scheduled message acts for the owner.
			expect(mockNoteSystemTurn).toHaveBeenCalledWith('test-team');
		});

		it('should reschedule recurring messages', async () => {
			const recurringMessage = { ...mockScheduledMessage, isRecurring: true };
			mockStorageService.saveDeliveryLog.mockResolvedValue(undefined);
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);
			mockStorageService.getProjects.mockResolvedValue([{ id: 'test-project', name: 'Test' }] as any);

			service.scheduleMessage(recurringMessage);

			// Execute first occurrence
			jest.advanceTimersByTime(300000);
			await Promise.resolve();

			// Should still have an active schedule for next occurrence
			expect(service.getStats().activeSchedules).toBe(1);
		});

		it('should remove one-time messages after execution', async () => {
			mockStorageService.saveDeliveryLog.mockResolvedValue(undefined);
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);
			mockStorageService.getProjects.mockResolvedValue([{ id: 'test-project', name: 'Test' }] as any);

			service.scheduleMessage(mockScheduledMessage);

			// Execute the message
			jest.advanceTimersByTime(300000);
			await jest.runAllTimersAsync();

			// Should be removed from active schedules
			expect(service.getStats().activeSchedules).toBe(0);
		});
	});

	describe('cancelMessage', () => {
		it('should cancel scheduled message', () => {
			service.scheduleMessage(mockScheduledMessage);
			expect(service.getStats().activeSchedules).toBe(1);

			service.cancelMessage('test-message-1');

			expect(service.getStats().activeSchedules).toBe(0);
			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Cancelled scheduled message',
				expect.objectContaining({ messageId: 'test-message-1' }),
			);
		});

		it('should do nothing if message does not exist', () => {
			mockLoggerInfo.mockClear();
			service.cancelMessage('nonexistent-message');

			expect(mockLoggerInfo).not.toHaveBeenCalledWith(
				'Cancelled scheduled message',
				expect.anything(),
			);
		});
	});

	describe('rescheduleAllMessages', () => {
		it('should cancel all and reload messages', async () => {
			mockStorageService.getScheduledMessages.mockResolvedValue([mockScheduledMessage]);
			const cancelAllSpy = jest.spyOn(service, 'cancelAllMessages').mockImplementation();
			const scheduleMessageSpy = jest.spyOn(service, 'scheduleMessage').mockImplementation();

			await service.rescheduleAllMessages();

			expect(mockLoggerInfo).toHaveBeenCalledWith('Rescheduling all messages...');
			expect(cancelAllSpy).toHaveBeenCalled();
			expect(mockStorageService.getScheduledMessages).toHaveBeenCalled();
			expect(scheduleMessageSpy).toHaveBeenCalledWith(mockScheduledMessage);
		});
	});

	describe('cancelAllMessages', () => {
		it('should cancel all scheduled messages', () => {
			service.scheduleMessage(mockScheduledMessage);
			service.scheduleMessage({ ...mockScheduledMessage, id: 'test-message-2' });
			expect(service.getStats().activeSchedules).toBe(2);

			service.cancelAllMessages();

			expect(service.getStats().activeSchedules).toBe(0);
			expect(mockLoggerInfo).toHaveBeenCalledWith('Cancelled all scheduled messages');
		});
	});

	describe('getStats', () => {
		it('should return correct statistics', () => {
			service.scheduleMessage(mockScheduledMessage);
			service.scheduleMessage({ ...mockScheduledMessage, id: 'test-message-2' });

			const stats = service.getStats();

			expect(stats).toEqual({
				activeSchedules: 2,
				scheduledMessageIds: ['test-message-1', 'test-message-2'],
			});
		});
	});

	describe('executeMessage', () => {
		beforeEach(() => {
			mockStorageService.saveDeliveryLog.mockResolvedValue(undefined);
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);
		});

		describe('team pause (specs/2026-10-04-team-pause.md)', () => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const registry = require('../team/team-pause.registry.js') as typeof import('../team/team-pause.registry.js');
			const pause = (teamId: string, session: string): void =>
				registry.notePausedTeam({
					id: teamId,
					name: 'Crewly',
					projectIds: [],
					createdAt: '2026-01-01',
					updatedAt: '2026-01-01',
					paused: { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' },
					members: [{ id: 'm1', name: 'Leo', sessionName: session, agentId: session }] as never,
				});
			afterEach(() => registry.resetTeamPauseRegistryForTesting());

			it.each([
				['its session', () => pause('team-x', 'test-team')],
				['its team id', () => pause('test-team', 'someone-else')],
			])('does not deliver a scheduled message to a paused target (by %s)', async (_label, setup) => {
				setup();
				const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };
				await (service as any).executeMessage(messageWithoutProject);
				expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
				expect(MessageDeliveryLogModel.create).toHaveBeenCalledWith(
					expect.objectContaining({ success: false, error: expect.stringContaining('paused by the owner') }),
				);
			});
		});

		it('should execute message for orchestrator team via sendMessageToAgent', async () => {
			const orchestratorMessage = { ...mockScheduledMessage, targetTeam: 'orchestrator', targetProject: undefined };

			await (service as any).executeMessage(orchestratorMessage);

			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
				expect.stringContaining('Hello World'),
				expect.any(String),
			);
		});

		it('should execute message for regular team via sendMessageToAgent', async () => {
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-team',
				expect.stringContaining('Hello World'),
				expect.any(String),
			);
			// Verify enhanced message includes continuation instructions
			const callArgs = mockAgentRegistrationService.sendMessageToAgent.mock.calls[0];
			expect(callArgs[1]).toContain('SCHEDULED CHECK-IN');
			expect(callArgs[1]).toContain('IMMEDIATELY CONTINUE');
		});

		it('should handle delivery failure from sendMessageToAgent', async () => {
			mockAgentRegistrationService.sendMessageToAgent.mockResolvedValue({
				success: false,
				error: 'Failed to deliver message after multiple attempts',
			});
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(MessageDeliveryLogModel.create).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					error: 'Failed to deliver message after multiple attempts',
				}),
			);
		});

		it('should resolve runtime type from storage service', async () => {
			mockStorageService.findMemberBySessionName.mockResolvedValue({
				team: { id: 'team-1' } as any,
				member: { sessionName: 'test-team', runtimeType: 'gemini-cli' } as any,
			});
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-team',
				expect.any(String),
				'gemini-cli',
			);
		});

		it('should default to claude-code when member not found', async () => {
			mockStorageService.findMemberBySessionName.mockResolvedValue(null);
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-team',
				expect.any(String),
				RUNTIME_TYPES.CLAUDE_CODE,
			);
		});

		it('should create delivery log', async () => {
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(MessageDeliveryLogModel.create).toHaveBeenCalledWith({
				scheduledMessageId: 'test-message-1',
				messageName: 'Test Message',
				targetTeam: 'test-team',
				targetProject: undefined,
				message: expect.stringContaining('Hello World'),
				success: true,
				error: undefined,
			});
			expect(mockStorageService.saveDeliveryLog).toHaveBeenCalledWith(mockDeliveryLog);
		});

		it('should handle delivery log save error', async () => {
			mockStorageService.saveDeliveryLog.mockRejectedValue(new Error('Log save error'));
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockLoggerError).toHaveBeenCalledWith(
				'Error saving delivery log',
				expect.objectContaining({ error: 'Log save error' }),
			);
		});

		it('should update message last run time', async () => {
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					lastRun: expect.any(String),
					updatedAt: expect.any(String),
				}),
			);
		});

		it('should deactivate one-time messages after execution', async () => {
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					isActive: false,
				}),
			);
			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'One-off message has been deactivated after execution',
				expect.objectContaining({ name: 'Test Message' }),
			);
		});

		it('should keep recurring messages active', async () => {
			const recurringMessage = { ...mockScheduledMessage, isRecurring: true, targetProject: undefined };

			await (service as any).executeMessage(recurringMessage);

			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					isActive: true,
				}),
			);
		});

		it('should handle message update error', async () => {
			mockStorageService.saveScheduledMessage.mockRejectedValue(new Error('Update error'));
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockLoggerError).toHaveBeenCalledWith(
				'Error updating message last run time',
				expect.objectContaining({ error: 'Update error' }),
			);
		});

		it('should emit message_executed event', async () => {
			const emitSpy = jest.spyOn(service, 'emit');
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(emitSpy).toHaveBeenCalledWith('message_executed', {
				message: messageWithoutProject,
				deliveryLog: mockDeliveryLog,
				success: true,
			});
		});
	});

	describe('getDelayInMilliseconds', () => {
		it('should convert seconds to milliseconds', () => {
			const result = (service as any).getDelayInMilliseconds(30, 'seconds');
			expect(result).toBe(30000);
		});

		it('should convert minutes to milliseconds', () => {
			const result = (service as any).getDelayInMilliseconds(5, 'minutes');
			expect(result).toBe(300000);
		});

		it('should convert hours to milliseconds', () => {
			const result = (service as any).getDelayInMilliseconds(2, 'hours');
			expect(result).toBe(7200000);
		});

		it('should throw error for invalid unit', () => {
			expect(() => {
				(service as any).getDelayInMilliseconds(1, 'days' as any);
			}).toThrow('Invalid delay unit: days');
		});
	});

	describe('loadAndScheduleAllMessages', () => {
		it('should load and schedule all active messages', async () => {
			const messages = [
				mockScheduledMessage,
				{ ...mockScheduledMessage, id: 'message-2', isActive: false },
				{ ...mockScheduledMessage, id: 'message-3', isActive: true },
			];
			mockStorageService.getScheduledMessages.mockResolvedValue(messages);
			const scheduleMessageSpy = jest.spyOn(service, 'scheduleMessage').mockImplementation();

			await (service as any).loadAndScheduleAllMessages();

			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Found active scheduled messages to schedule',
				expect.objectContaining({ count: 2 }),
			);
			expect(scheduleMessageSpy).toHaveBeenCalledTimes(2);
			expect(scheduleMessageSpy).toHaveBeenCalledWith(mockScheduledMessage);
			expect(scheduleMessageSpy).toHaveBeenCalledWith({ ...mockScheduledMessage, id: 'message-3', isActive: true });
		});

		it('should handle storage error', async () => {
			mockStorageService.getScheduledMessages.mockRejectedValue(new Error('Storage error'));

			await (service as any).loadAndScheduleAllMessages();

			expect(mockLoggerError).toHaveBeenCalledWith(
				'Error loading scheduled messages',
				expect.objectContaining({ error: 'Storage error' }),
			);
		});
	});

	describe('cleanup', () => {
		it('should cleanup all timers', () => {
			service.scheduleMessage(mockScheduledMessage);
			service.scheduleMessage({ ...mockScheduledMessage, id: 'message-2' });
			expect(service.getStats().activeSchedules).toBe(2);

			service.cleanup();

			expect(service.getStats().activeSchedules).toBe(0);
			expect(mockLoggerInfo).toHaveBeenCalledWith('Message scheduler service cleaned up');
		});
	});

	describe('Sequential Message Processing', () => {
		const mockAutoAssignmentMessage: ScheduledMessage = {
			id: 'auto-assign-project-123',
			name: 'Auto Task Assignment - Test Project',
			targetTeam: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
			targetProject: 'project-123',
			message: 'Auto assignment check message',
			delayAmount: 15,
			delayUnit: 'minutes',
			isRecurring: true,
			isActive: true,
			createdAt: '2023-01-01T00:00:00.000Z',
			updatedAt: '2023-01-01T00:00:00.000Z',
		};

		beforeEach(() => {
			mockStorageService.saveDeliveryLog.mockResolvedValue(undefined);
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);
			(MessageDeliveryLogModel.create as jest.Mock).mockReturnValue(mockDeliveryLog);
		});

		it('should route all messages through sequential queue', async () => {
			const executeMessageSpy = jest.spyOn(service as any, 'executeMessage');
			const executeMessageSequentiallySpy = jest.spyOn(service as any, 'executeMessageSequentially').mockResolvedValue(undefined);

			service.scheduleMessage(mockAutoAssignmentMessage);

			jest.advanceTimersByTime(15 * 60 * 1000);
			await Promise.resolve();

			expect(executeMessageSequentiallySpy).toHaveBeenCalledWith(mockAutoAssignmentMessage);
			expect(executeMessageSpy).not.toHaveBeenCalledWith(mockAutoAssignmentMessage);
		});

		it('should process regular messages through queue', async () => {
			const regularMessage = { ...mockScheduledMessage, delayAmount: 1, delayUnit: 'seconds' as const };
			const executeMessageSpy = jest.spyOn(service as any, 'executeMessage');
			const executeMessageSequentiallySpy = jest.spyOn(service as any, 'executeMessageSequentially').mockResolvedValue(undefined);

			service.scheduleMessage(regularMessage);

			jest.advanceTimersByTime(1000);
			await Promise.resolve();

			expect(executeMessageSequentiallySpy).toHaveBeenCalledWith(regularMessage);
			expect(executeMessageSpy).not.toHaveBeenCalledWith(regularMessage);
		});

		it('should process multiple messages sequentially', async () => {
			const message1 = { ...mockAutoAssignmentMessage, id: 'auto-assign-1', targetProject: 'project-1' };
			const message2 = { ...mockAutoAssignmentMessage, id: 'auto-assign-2', targetProject: 'project-2' };
			const message3 = { ...mockAutoAssignmentMessage, id: 'auto-assign-3', targetProject: 'project-3' };

			const executionOrder: string[] = [];
			jest.spyOn(service as any, 'executeMessage').mockImplementation(async (...args: any[]) => {
				const msg = args[0] as ScheduledMessage;
				executionOrder.push(msg.id);
				await Promise.resolve();
			});

			const promise1 = (service as any).executeMessageSequentially(message1);
			const promise2 = (service as any).executeMessageSequentially(message2);
			const promise3 = (service as any).executeMessageSequentially(message3);

			await jest.advanceTimersByTimeAsync(2000);
			await jest.advanceTimersByTimeAsync(2000);
			await jest.advanceTimersByTimeAsync(2000);

			await Promise.all([promise1, promise2, promise3]);

			expect(executionOrder).toEqual(['auto-assign-1', 'auto-assign-2', 'auto-assign-3']);
		});

		it('should handle errors in sequential processing', async () => {
			const failingMessage = { ...mockAutoAssignmentMessage, id: 'failing-message' };

			jest.spyOn(service as any, 'executeMessage').mockRejectedValue(new Error('Execution failed'));

			await expect((service as any).executeMessageSequentially(failingMessage))
				.rejects.toThrow('Execution failed');

			expect(mockLoggerError).toHaveBeenCalledWith(
				'Error processing queued message',
				expect.objectContaining({ name: 'Auto Task Assignment - Test Project' }),
			);
		});

		it('should add delay between sequential executions', async () => {
			const message1 = { ...mockAutoAssignmentMessage, id: 'auto-assign-delay-1' };
			const message2 = { ...mockAutoAssignmentMessage, id: 'auto-assign-delay-2' };

			let executeCallCount = 0;
			jest.spyOn(service as any, 'executeMessage').mockImplementation(async () => {
				executeCallCount++;
			});

			const promise1 = (service as any).executeMessageSequentially(message1);
			const promise2 = (service as any).executeMessageSequentially(message2);

			await jest.advanceTimersByTimeAsync(2000);
			await jest.advanceTimersByTimeAsync(2000);

			await Promise.all([promise1, promise2]);

			expect(executeCallCount).toBe(2);
		});

		it('should log queue processing information', async () => {
			const queueMessage = { ...mockAutoAssignmentMessage, targetProject: 'test-project-queue' };

			const executionPromise = (service as any).executeMessageSequentially(queueMessage);

			await jest.advanceTimersByTimeAsync(2000);
			await executionPromise;

			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Processing scheduled message',
				expect.objectContaining({ targetProject: 'test-project-queue' }),
			);
			expect(mockLoggerInfo).toHaveBeenCalledWith('Finished processing message queue');
		});
	});

	describe('validateProjectExists', () => {
		it('should return true for existing project', async () => {
			const mockProject = { id: 'test-project', name: 'Test Project' };
			mockStorageService.getProjects.mockResolvedValue([mockProject] as any);

			const result = await (service as any).validateProjectExists('test-project');

			expect(result).toBe(true);
			expect(mockStorageService.getProjects).toHaveBeenCalled();
		});

		it('should return false for non-existent project', async () => {
			mockStorageService.getProjects.mockResolvedValue([]);

			const result = await (service as any).validateProjectExists('non-existent-project');

			expect(result).toBe(false);
			expect(mockStorageService.getProjects).toHaveBeenCalled();
		});

		it('should return false when storage service throws error', async () => {
			mockStorageService.getProjects.mockRejectedValue(new Error('Storage error'));

			const result = await (service as any).validateProjectExists('test-project');

			expect(result).toBe(false);
			expect(mockLoggerError).toHaveBeenCalledWith(
				'Error validating project existence',
				expect.objectContaining({ error: 'Storage error' }),
			);
		});
	});

	describe('executeMessage with project validation', () => {
		beforeEach(() => {
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);
			mockStorageService.saveDeliveryLog.mockResolvedValue(undefined);
		});

		it('should execute message when project exists', async () => {
			const mockProject = {
				id: 'test-project',
				name: 'Test Project',
				path: '/test/path',
				teams: {},
				status: 'active',
				createdAt: '2023-01-01T00:00:00.000Z',
				updatedAt: '2023-01-01T00:00:00.000Z',
			};
			mockStorageService.getProjects.mockResolvedValue([mockProject] as any);

			await (service as any).executeMessage(mockScheduledMessage);

			expect(mockStorageService.getProjects).toHaveBeenCalled();
			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-team',
				expect.stringContaining('Hello World'),
				expect.any(String),
			);
			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					isActive: false, // Should be deactivated since it's non-recurring
				}),
			);
		});

		it('should deactivate message when project does not exist', async () => {
			mockStorageService.getProjects.mockResolvedValue([]);

			await (service as any).executeMessage(mockScheduledMessage);

			expect(mockStorageService.getProjects).toHaveBeenCalled();
			expect(mockAgentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					isActive: false,
				}),
			);
			expect(mockLoggerWarn).toHaveBeenCalledWith(
				'Deactivating orphaned scheduled message',
				expect.objectContaining({ name: 'Test Message' }),
			);
		});

		it('should cancel message timer when deactivating orphaned message', async () => {
			mockStorageService.getProjects.mockResolvedValue([]);
			const cancelMessageSpy = jest.spyOn(service, 'cancelMessage');

			await (service as any).executeMessage(mockScheduledMessage);

			expect(cancelMessageSpy).toHaveBeenCalledWith(mockScheduledMessage.id);
		});

		it('should not validate project for messages without targetProject', async () => {
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };

			await (service as any).executeMessage(messageWithoutProject);

			expect(mockStorageService.getProjects).not.toHaveBeenCalled();
			expect(mockAgentRegistrationService.sendMessageToAgent).toHaveBeenCalled();
		});
	});

	describe('cleanupOrphanedMessages', () => {
		it('should find and deactivate orphaned messages', async () => {
			const orphanedMessage = { ...mockScheduledMessage, targetProject: 'orphaned-project' };
			const validMessage = { ...mockScheduledMessage, id: 'valid-msg', targetProject: 'valid-project' };

			mockStorageService.getScheduledMessages.mockResolvedValue([orphanedMessage, validMessage]);
			mockStorageService.getProjects.mockResolvedValue([{
				id: 'valid-project',
				name: 'Valid Project',
				path: '/valid/path',
				teams: {},
				status: 'active',
				createdAt: '2023-01-01T00:00:00.000Z',
				updatedAt: '2023-01-01T00:00:00.000Z',
			}] as any);
			mockStorageService.saveScheduledMessage.mockResolvedValue(undefined);

			const result = await service.cleanupOrphanedMessages();

			expect(result.found).toBe(2);
			expect(result.deactivated).toBe(1);
			expect(result.errors).toHaveLength(0);
			expect(mockStorageService.saveScheduledMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					id: orphanedMessage.id,
					isActive: false,
				}),
			);
		});

		it('should return early when no project-targeted messages found', async () => {
			const messageWithoutProject = { ...mockScheduledMessage, targetProject: undefined };
			mockStorageService.getScheduledMessages.mockResolvedValue([messageWithoutProject]);

			const result = await service.cleanupOrphanedMessages();

			expect(result.found).toBe(0);
			expect(result.deactivated).toBe(0);
			expect(result.errors).toHaveLength(0);
		});

		it('should handle errors when deactivating individual messages', async () => {
			const orphanedMessage = { ...mockScheduledMessage, targetProject: 'orphaned-project' };

			mockStorageService.getScheduledMessages.mockResolvedValue([orphanedMessage]);
			mockStorageService.getProjects.mockResolvedValue([]);
			mockStorageService.saveScheduledMessage.mockRejectedValue(new Error('Save failed'));

			const result = await service.cleanupOrphanedMessages();

			expect(result.found).toBe(1);
			expect(result.deactivated).toBe(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain('Failed to process message');
		});

		it('should handle storage service errors gracefully', async () => {
			mockStorageService.getScheduledMessages.mockRejectedValue(new Error('Storage error'));

			const result = await service.cleanupOrphanedMessages();

			expect(result.found).toBe(0);
			expect(result.deactivated).toBe(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain('Failed to cleanup orphaned messages');
		});
	});
});
