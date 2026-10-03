import { TmuxService } from './tmux.service.js';
import { TmuxCommandService } from './tmux-command.service.js';
import { RuntimeServiceFactory } from './runtime-service.factory.js';
import { AgentRegistrationService } from './agent-registration.service.js';
import { PromptBuilderService } from '../ai/prompt-builder.service.js';
import { StorageService } from '../core/storage.service.js';
import { LoggerService } from '../core/logger.service.js';
import { mintAgentBadge } from '../core/owner-auth.service.js';

// Mock all dependencies
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn().mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

jest.mock('./tmux-command.service.js');
jest.mock('./runtime-service.factory.js');
jest.mock('./agent-registration.service.js');
jest.mock('../ai/prompt-builder.service.js');
jest.mock('../core/storage.service.js', () => ({
	StorageService: {
		getInstance: jest.fn().mockReturnValue({
			getOrchestratorStatus: jest.fn().mockResolvedValue(null),
		}),
	},
}));

jest.mock('fs', () => ({
	accessSync: jest.fn(),
}));

jest.mock('child_process', () => ({
	spawn: jest.fn(),
}));

describe('TmuxService', () => {
	let service: TmuxService;
	let mockTmuxCommand: jest.Mocked<TmuxCommandService>;
	let mockAgentRegistration: jest.Mocked<AgentRegistrationService>;
	let mockPromptBuilder: jest.Mocked<PromptBuilderService>;
	let mockRuntimeService: any;

	beforeEach(() => {
		jest.clearAllMocks();

		// Mock the constructors to return mocked instances
		mockTmuxCommand = {
			sessionExists: jest.fn(),
			killSession: jest.fn(),
			createSession: jest.fn(),
			sendMessage: jest.fn(),
			sendEnter: jest.fn(),
			sendKey: jest.fn(),
			capturePane: jest.fn(),
			listSessions: jest.fn(),
			setEnvironmentVariable: jest.fn(),
			executeTmuxCommand: jest.fn(),
			clearCurrentCommandLine: jest.fn(),
		} as any;

		mockRuntimeService = {
			checkClaudeInstallation: jest.fn(),
			initializeClaudeInSession: jest.fn(),
			executeRuntimeInitScript: jest.fn().mockResolvedValue(undefined),
		};

		mockAgentRegistration = {
			initializeAgentWithRegistration: jest.fn(),
		} as any;

		mockPromptBuilder = {
			buildOrchestratorPrompt: jest.fn(),
		} as any;

		// Mock constructors
		(TmuxCommandService as unknown as jest.Mock).mockImplementation(() => mockTmuxCommand);
		(RuntimeServiceFactory.create as jest.Mock) = jest.fn().mockReturnValue(mockRuntimeService);
		(AgentRegistrationService as unknown as jest.Mock).mockImplementation(() => mockAgentRegistration);
		(PromptBuilderService as unknown as jest.Mock).mockImplementation(() => mockPromptBuilder);

		// Mock fs.accessSync for project root detection
		require('fs').accessSync.mockImplementation(() => true);

		service = new TmuxService();
	});

	afterEach(() => {
		if (service) {
			service.destroy();
		}
	});

	describe('constructor', () => {
		it('should initialize all specialized services', () => {
			expect(TmuxCommandService).toHaveBeenCalledTimes(1);
			expect(AgentRegistrationService).toHaveBeenCalledTimes(1);
			expect(PromptBuilderService).toHaveBeenCalledTimes(1);
			expect(LoggerService.getInstance).toHaveBeenCalled();
		});
	});

	describe('createOrchestratorSession', () => {
		it('should create orchestrator session successfully', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(false);
			mockTmuxCommand.createSession.mockResolvedValue();

			const config = {
				sessionName: 'orchestrator',
				projectPath: '/test/project',
				windowName: 'main',
			};

			const result = await service.createOrchestratorSession(config);

			expect(result.success).toBe(true);
			expect(result.sessionName).toBe('orchestrator');
			expect(result.message).toBe('Orchestrator session created successfully');
			expect(mockTmuxCommand.createSession).toHaveBeenCalledWith(
				'orchestrator',
				'/test/project',
				'main',
				// The agent badge (#999) rides in the spawn env with the identity
				{ CREWLY_SESSION_NAME: 'orchestrator', CREWLY_AGENT_BADGE: mintAgentBadge('orchestrator'), CREWLY_ROLE: 'orchestrator' }
			);
		});

		it('should return success if session already exists', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(true);

			const config = {
				sessionName: 'orchestrator',
				projectPath: '/test/project',
			};

			const result = await service.createOrchestratorSession(config);

			expect(result.success).toBe(true);
			expect(result.message).toBe('Orchestrator session already running');
			expect(mockTmuxCommand.createSession).not.toHaveBeenCalled();
		});

		it('should handle creation errors', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(false);
			mockTmuxCommand.createSession.mockRejectedValue(new Error('Creation failed'));

			const config = {
				sessionName: 'orchestrator',
				projectPath: '/test/project',
			};

			const result = await service.createOrchestratorSession(config);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Creation failed');
		});
	});

	describe('initializeOrchestrator', () => {
		it('should delegate to agent registration service', async () => {
			mockAgentRegistration.initializeAgentWithRegistration.mockResolvedValue({
				success: true,
				message: 'Orchestrator initialized',
			});

			const result = await service.initializeOrchestrator('orchestrator', 60000);

			expect(result.success).toBe(true);
			expect(result.message).toBe('Orchestrator initialized');
			expect(mockAgentRegistration.initializeAgentWithRegistration).toHaveBeenCalledWith(
				'orchestrator',
				'orchestrator',
				expect.any(String),
				60000,
				undefined,
				'claude-code'
			);
		});
	});

	describe('sendProjectStartPrompt', () => {
		it('should send project start prompt successfully', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(true);
			mockPromptBuilder.buildOrchestratorPrompt.mockReturnValue('Test orchestrator prompt');
			mockTmuxCommand.sendMessage.mockResolvedValue();
			mockTmuxCommand.sendEnter.mockResolvedValue();

			const projectData = {
				projectName: 'Test Project',
				projectPath: '/test/path',
				teamDetails: { name: 'Test Team' },
				requirements: 'Build an app',
			};

			const result = await service.sendProjectStartPrompt('orchestrator', projectData);

			expect(result.success).toBe(true);
			expect(result.message).toBe('Project start prompt sent to orchestrator');
			expect(mockPromptBuilder.buildOrchestratorPrompt).toHaveBeenCalledWith(projectData);
		});

		it('should fail if session does not exist', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(false);

			const projectData = {
				projectName: 'Test Project',
				projectPath: '/test/path',
				teamDetails: { name: 'Test Team' },
			};

			const result = await service.sendProjectStartPrompt('orchestrator', projectData);

			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
		});
	});

	describe('checkClaudeInstallation', () => {
		it('should delegate to runtime service factory', async () => {
			mockRuntimeService.checkClaudeInstallation.mockResolvedValue({
				installed: true,
				version: '1.0.0',
				message: 'Claude installed',
			});

			const result = await service.checkClaudeInstallation();

			expect(result.installed).toBe(true);
			expect(result.version).toBe('1.0.0');
			expect(RuntimeServiceFactory.create).toHaveBeenCalledWith('claude-code', mockTmuxCommand, expect.any(String));
		});
	});

	describe('createTeamMemberSession', () => {
		const mockConfig = {
			name: 'test-dev',
			role: 'developer' as const,
			systemPrompt: 'You are a developer agent.',
			projectPath: '/test/project',
			memberId: 'dev-123',
		};

		it('should create team member session successfully', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(false);
			mockTmuxCommand.killSession.mockResolvedValue();
			mockTmuxCommand.createSession.mockResolvedValue();
			mockTmuxCommand.setEnvironmentVariable.mockResolvedValue();
			mockAgentRegistration.initializeAgentWithRegistration.mockResolvedValue({
				success: true,
				message: 'Agent registered',
			});

			const result = await service.createTeamMemberSession(mockConfig, 'test-dev');

			expect(result.success).toBe(true);
			expect(result.sessionName).toBe('test-dev');
			expect(result.message).toBe('Team member session created successfully');
			expect(mockTmuxCommand.createSession).toHaveBeenCalledWith('test-dev', '/test/project', undefined, {
				CREWLY_SESSION_NAME: 'test-dev',
				CREWLY_AGENT_BADGE: mintAgentBadge('test-dev'),
				CREWLY_ROLE: 'developer',
			});
			// Identity rides in the spawn env; nothing is typed in as `export`
			expect(mockTmuxCommand.setEnvironmentVariable).not.toHaveBeenCalled();
			expect(mockAgentRegistration.initializeAgentWithRegistration).toHaveBeenCalledWith(
				'test-dev',
				'developer',
				'/test/project',
				75000,
				'dev-123',
				'claude-code'
			);
		});

		it('should handle agent initialization failure', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(false);
			mockTmuxCommand.killSession.mockResolvedValue();
			mockTmuxCommand.createSession.mockResolvedValue();
			mockTmuxCommand.setEnvironmentVariable.mockResolvedValue();
			mockAgentRegistration.initializeAgentWithRegistration.mockResolvedValue({
				success: false,
				error: 'Registration failed',
			});

			const result = await service.createTeamMemberSession(mockConfig, 'test-dev');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Agent initialization failed');
		});
	});

	describe('sendMessage', () => {
		it('should send message using robust script approach', async () => {
			mockTmuxCommand.clearCurrentCommandLine.mockResolvedValue();
			mockTmuxCommand.sendMessage.mockResolvedValue();

			const eventSpy = jest.fn();
			service.on('message_sent', eventSpy);

			await service.sendMessage('test-session', 'Hello Claude');

			expect(mockTmuxCommand.clearCurrentCommandLine).toHaveBeenCalledWith('test-session');
			expect(mockTmuxCommand.sendMessage).toHaveBeenCalledWith('test-session', 'Hello Claude');
			expect(eventSpy).toHaveBeenCalledWith({
				sessionName: 'test-session',
				message: 'Hello Claude',
				method: 'robust_script'
			});
		});

		it('should throw error when sendMessage fails', async () => {
			mockTmuxCommand.clearCurrentCommandLine.mockResolvedValue();
			mockTmuxCommand.sendMessage.mockRejectedValue(new Error('Send failed'));

			await expect(service.sendMessage('test-session', 'Hello Claude')).rejects.toThrow('Send failed');
		});

		it('should throw error when clearCurrentCommandLine fails', async () => {
			mockTmuxCommand.clearCurrentCommandLine.mockRejectedValue(new Error('Clear failed'));

			await expect(service.sendMessage('test-session', 'Hello Claude')).rejects.toThrow('Clear failed');
		});
	});

	describe('isSessionAttached', () => {
		it('should return true for attached sessions', async () => {
			mockTmuxCommand.executeTmuxCommand.mockResolvedValue('attached');

			const result = await service.isSessionAttached('test-session');

			expect(result).toBe(true);
			expect(mockTmuxCommand.executeTmuxCommand).toHaveBeenCalledWith([
				'display-message', '-p', '-t', 'test-session', '#{?session_attached,attached,detached}'
			]);
		});

		it('should return false for detached sessions', async () => {
			mockTmuxCommand.executeTmuxCommand.mockResolvedValue('detached');

			const result = await service.isSessionAttached('test-session');

			expect(result).toBe(false);
		});

		it('should return false when session status check fails', async () => {
			mockTmuxCommand.executeTmuxCommand.mockRejectedValue(new Error('Session not found'));

			const result = await service.isSessionAttached('test-session');

			expect(result).toBe(false);
		});
	});

	describe('sendMessageDirectly', () => {
		it('should send message using direct send-keys approach', async () => {
			mockTmuxCommand.clearCurrentCommandLine.mockResolvedValue();
			mockTmuxCommand.executeTmuxCommand.mockResolvedValue('');

			const eventSpy = jest.fn();
			service.on('message_sent', eventSpy);

			await service.sendMessageDirectly('test-session', 'Direct message');

			expect(mockTmuxCommand.clearCurrentCommandLine).toHaveBeenCalledWith('test-session');
			// Updated to match new implementation with literal mode and separate Enter
			expect(mockTmuxCommand.executeTmuxCommand).toHaveBeenCalledWith([
				'send-keys', '-t', 'test-session', '-l', '--', 'Direct message'
			]);
			expect(eventSpy).toHaveBeenCalledWith({
				sessionName: 'test-session',
				message: 'Direct message',
				method: 'direct'
			});
		});

		it('should throw error when direct send fails', async () => {
			mockTmuxCommand.clearCurrentCommandLine.mockResolvedValue();
			mockTmuxCommand.executeTmuxCommand.mockRejectedValue(new Error('Send failed'));

			await expect(service.sendMessageDirectly('test-session', 'message')).rejects.toThrow('Send failed');
		});
	});

	describe('sessionExists', () => {
		it('should delegate to tmux command service', async () => {
			mockTmuxCommand.sessionExists.mockResolvedValue(true);

			const result = await service.sessionExists('test-session');

			expect(result).toBe(true);
			expect(mockTmuxCommand.sessionExists).toHaveBeenCalledWith('test-session');
		});
	});

	describe('listSessions', () => {
		it('should delegate to tmux command service', async () => {
			const mockSessions = [
				{
					sessionName: 'test-session',
					pid: 12345,
					windows: 1,
					created: '2023-01-01T00:00:00.000Z',
					attached: false,
				},
			];
			mockTmuxCommand.listSessions.mockResolvedValue(mockSessions);

			const result = await service.listSessions();

			expect(result).toEqual(mockSessions);
			expect(mockTmuxCommand.listSessions).toHaveBeenCalled();
		});
	});

	describe('killSession', () => {
		it('should kill session and clean up tracking', async () => {
			mockTmuxCommand.killSession.mockResolvedValue();

			const eventSpy = jest.fn();
			service.on('session_killed', eventSpy);

			await service.killSession('test-session');

			expect(mockTmuxCommand.killSession).toHaveBeenCalledWith('test-session');
			expect(eventSpy).toHaveBeenCalledWith({ sessionName: 'test-session' });
		});
	});

	describe('destroy', () => {
		it('should clean up resources', () => {
			// The constructor sets up an interval, destroy should clear it
			service.destroy();

			// Verify that subsequent destroy doesn't throw
			expect(() => service.destroy()).not.toThrow();
		});
	});
});
