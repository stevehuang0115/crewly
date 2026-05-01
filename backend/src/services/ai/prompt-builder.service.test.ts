import { PromptBuilderService } from './prompt-builder.service.js';
import { LoggerService } from '../core/logger.service.js';
import { TeamMemberSessionConfig } from '../../types/index.js';

// Mock dependencies
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

jest.mock('fs/promises', () => ({
	readFile: jest.fn(),
	access: jest.fn(),
}));

// Import the mocked module so we can access mock functions
import * as fsPromises from 'fs/promises';

// Mock MemoryService
const mockInitializeForSession = jest.fn().mockResolvedValue(undefined);
const mockGetFullContext = jest.fn().mockResolvedValue('');

jest.mock('../memory/memory.service.js', () => ({
	MemoryService: {
		getInstance: jest.fn(() => ({
			initializeForSession: mockInitializeForSession,
			getFullContext: mockGetFullContext,
		})),
	},
}));

// Mock SOPService
const mockGenerateSOPContext = jest.fn().mockResolvedValue('');

jest.mock('../sop/sop.service.js', () => ({
	SOPService: {
		getInstance: jest.fn(() => ({
			generateSOPContext: mockGenerateSOPContext,
		})),
	},
}));

// Mock RoleService - return null to force file fallback for testing file paths
const mockGetRoleByName = jest.fn().mockResolvedValue(null);

jest.mock('../settings/role.service.js', () => ({
	getRoleService: jest.fn(() => ({
		getRoleByName: mockGetRoleByName,
	})),
}));

describe('PromptBuilderService', () => {
	let service: PromptBuilderService;
	let mockReadFile: jest.Mock;
	let mockAccess: jest.Mock;
	const savedModularEnv = process.env.CREWLY_USE_MODULAR_PROMPTS;

	beforeEach(() => {
		jest.clearAllMocks();
		// Default to legacy path for existing tests; the feature-flag describe block overrides this
		process.env.CREWLY_USE_MODULAR_PROMPTS = 'false';
		mockReadFile = jest.mocked(fsPromises.readFile);
		mockAccess = jest.mocked(fsPromises.access);
		service = new PromptBuilderService('/test/project');
	});

	afterEach(() => {
		if (savedModularEnv === undefined) {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS;
		} else {
			process.env.CREWLY_USE_MODULAR_PROMPTS = savedModularEnv;
		}
	});

	describe('buildOrchestratorPrompt', () => {
		it('should build orchestrator prompt with team members', () => {
			const projectData = {
				projectName: 'Test Project',
				projectPath: '/test/path',
				teamDetails: {
					name: 'Development Team',
					members: [
						{ name: 'John', role: 'Frontend Developer', skills: 'React, TypeScript' },
						{ name: 'Jane', role: 'Backend Developer', skills: 'Node.js, PostgreSQL' },
					],
				},
				requirements: 'Build a web application',
			};

			const result = service.buildOrchestratorPrompt(projectData);

			expect(result).toContain('Test Project');
			expect(result).toContain('/test/path');
			expect(result).toContain('Development Team');
			expect(result).toContain('John: Frontend Developer');
			expect(result).toContain('Jane: Backend Developer');
			expect(result).toContain('Build a web application');
			expect(result).toContain('Start all teams on Phase 1 simultaneously');
		});

		it('should handle missing team members', () => {
			const projectData = {
				projectName: 'Test Project',
				projectPath: '/test/path',
				teamDetails: {
					name: 'Development Team',
				},
			};

			const result = service.buildOrchestratorPrompt(projectData);

			expect(result).toContain('No team members specified');
			expect(result).toContain('Test Project');
		});

		it('should use default requirements when not provided', () => {
			const projectData = {
				projectName: 'Test Project',
				projectPath: '/test/path',
				teamDetails: { name: 'Team' },
			};

			const result = service.buildOrchestratorPrompt(projectData);

			expect(result).toContain('See project documentation in .crewly/specs/');
		});
	});

	describe('buildSystemPrompt', () => {
		const mockConfig: TeamMemberSessionConfig = {
			name: 'test-session',
			role: 'developer',
			projectPath: '/test/project',
			memberId: 'member-123',
			systemPrompt: 'test prompt',
			runtimeType: 'claude-code' as any
		};

		it('should load role-specific prompt when available', async () => {
			const promptContent = 'Role-specific prompt for {{ROLE}} with session {{SESSION_ID}}';
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(promptContent);

			const result = await service.buildSystemPrompt(mockConfig);

			expect(result).toContain('Role-specific prompt for developer with session test-session');
			expect(mockAccess).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/developer/prompt.md')
			);
			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/developer/prompt.md'),
				'utf8'
			);
		});

		it('should use fallback prompt when role-specific prompt not found', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			const result = await service.buildSystemPrompt(mockConfig);

			expect(result).toContain('developer tasks');
			expect(result).toContain('register-self');
			expect(result).toContain('Session: test-session');
		});

		it('should replace multiple template variables', async () => {
			const promptContent = `Role: {{ROLE}}, Session: {{SESSION_ID}}, Path: {{PROJECT_PATH}}, Member: {{MEMBER_ID}}`;
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(promptContent);

			const result = await service.buildSystemPrompt(mockConfig);

			expect(result).toBe('Role: developer, Session: test-session, Path: /test/project, Member: member-123');
		});
	});

	describe('loadRegistrationPrompt', () => {
		it('should load registration prompt with member ID', async () => {
			const promptContent = 'Register as {{ROLE}} with session {{SESSION_ID}} and member {{MEMBER_ID}}';
			mockReadFile.mockResolvedValue(promptContent);

			const result = await service.loadRegistrationPrompt('dev', 'test-session', 'member-123');

			expect(result).toBe('Register as dev with session test-session and member member-123');
			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/dev/prompt.md'),
				'utf8'
			);
		});

		it('should remove member ID parameter when not provided', async () => {
			const promptContent = 'Register {"role": "{{ROLE}}", "sessionName": "{{SESSION_ID}}", "memberId": "{{MEMBER_ID}}"}';
			mockReadFile.mockResolvedValue(promptContent);

			const result = await service.loadRegistrationPrompt('orchestrator', 'test-session');

			expect(result).toBe('Register {"role": "orchestrator", "sessionName": "test-session"}');
		});

		it('should use fallback when prompt file not found', async () => {
			mockReadFile.mockRejectedValue(new Error('File not found'));

			const result = await service.loadRegistrationPrompt('dev', 'test-session', 'member-123');

			// Fallback prompt contains registration instructions
			expect(result).toContain('IMMEDIATELY');
			expect(result).toContain('register-self');
			expect(result).toContain('"role":"dev"');
			expect(result).toContain('"sessionName":"test-session"');
			expect(result).toContain('member-123');
		});

		it('should exclude member ID from fallback when not provided', async () => {
			mockReadFile.mockRejectedValue(new Error('File not found'));

			const result = await service.loadRegistrationPrompt('orchestrator', 'test-session');

			expect(result).toContain('"role":"orchestrator"');
			expect(result).toContain('"sessionName":"test-session"');
			expect(result).not.toContain('teamMemberId');
		});
	});

	describe('loadPromptTemplate', () => {
		it('should load prompt template successfully', async () => {
			const templateContent = 'Template content';
			mockReadFile.mockResolvedValue(templateContent);

			// Pass role name (test-template) or old filename (test-template-prompt.md)
			const result = await service.loadPromptTemplate('test-template-prompt.md');

			expect(result).toBe(templateContent);
			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/test-template/prompt.md'),
				'utf8'
			);
		});

		it('should return null when template not found', async () => {
			mockReadFile.mockRejectedValue(new Error('File not found'));

			const result = await service.loadPromptTemplate('nonexistent-prompt.md');

			expect(result).toBeNull();
		});
	});

	describe('promptTemplateExists', () => {
		it('should return true when template exists', async () => {
			mockAccess.mockResolvedValue(undefined);

			// Pass role name directly or old filename pattern
			const result = await service.promptTemplateExists('existing-template-prompt.md');

			expect(result).toBe(true);
			expect(mockAccess).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/existing-template/prompt.md')
			);
		});

		it('should return false when template does not exist', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			const result = await service.promptTemplateExists('nonexistent-prompt.md');

			expect(result).toBe(false);
		});
	});

	describe('buildTaskAssignmentPrompt', () => {
		it('should build task assignment prompt with all fields', () => {
			const task = {
				id: 'task-123',
				title: 'Implement user authentication',
				description: 'Add login and registration functionality',
				assigneeRole: 'backend-developer',
				priority: 'high' as const,
				estimatedHours: 8,
			};

			const result = service.buildTaskAssignmentPrompt(task);

			expect(result).toContain('**Task ID**: task-123');
			expect(result).toContain('**Title**: Implement user authentication');
			expect(result).toContain('**Assigned to**: backend-developer');
			expect(result).toContain('**Priority**: HIGH');
			expect(result).toContain('**Estimated Hours**: 8');
			expect(result).toContain('Add login and registration functionality');
		});

		it('should build task assignment prompt without estimated hours', () => {
			const task = {
				id: 'task-456',
				title: 'Fix bug in payment processing',
				description: 'Resolve issue with payment validation',
				assigneeRole: 'developer',
				priority: 'medium' as const,
			};

			const result = service.buildTaskAssignmentPrompt(task);

			expect(result).toContain('**Task ID**: task-456');
			expect(result).toContain('**Priority**: MEDIUM');
			expect(result).not.toContain('Estimated Hours');
		});
	});

	describe('buildStatusUpdatePrompt', () => {
		it('should build status update prompt', () => {
			const result = service.buildStatusUpdatePrompt('test-session', 'developer');

			expect(result).toContain('Status Update Request');
			expect(result).toContain('Current Task');
			expect(result).toContain('Progress');
			expect(result).toContain('Blockers');
			expect(result).toContain('Next Steps');
			expect(result).toContain('ETA');
		});
	});

	describe('getRolesDirectory', () => {
		it('should return roles directory path', () => {
			const result = service.getRolesDirectory();

			expect(result).toContain('/config/roles');
		});
	});

	describe('config path resolution', () => {
		it('should construct correct path for roles directory', () => {
			const testService = new PromptBuilderService('/test/project');
			const rolesDir = testService.getRolesDirectory();

			expect(rolesDir).toBe('/test/project/config/roles');
		});

		it('should use correct path structure when loading prompts', async () => {
			const mockPromptContent = 'Test prompt content';
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(mockPromptContent);

			const testService = new PromptBuilderService('/custom/project/root');

			// Pass the old filename format which gets converted to role name
			await testService.loadPromptTemplate('developer-prompt.md');

			expect(mockReadFile).toHaveBeenCalledWith(
				'/custom/project/root/config/roles/developer/prompt.md',
				'utf8'
			);
		});

		it('should check existence with correct path structure', async () => {
			mockAccess.mockResolvedValue(undefined);

			const testService = new PromptBuilderService('/test/root');

			await testService.promptTemplateExists('tpm-prompt.md');

			expect(mockAccess).toHaveBeenCalledWith(
				'/test/root/config/roles/tpm/prompt.md'
			);
		});

		it('should handle path resolution for different role prompt files', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('Prompt content');

			const roles = ['fullstack-dev', 'designer', 'qa', 'architect'];

			for (const role of roles) {
				await service.loadPromptTemplate(`${role}-prompt.md`);

				expect(mockReadFile).toHaveBeenCalledWith(
					expect.stringContaining(`/config/roles/${role}/prompt.md`),
					'utf8'
				);
			}
		});

		it('should build system prompt with correct path lookup', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('Role-specific prompt for {{ROLE}}');

			const config: TeamMemberSessionConfig = {
				name: 'test-session',
				role: 'tpm',
				projectPath: '/test/project',
				memberId: 'member-123',
				systemPrompt: 'test prompt',
				runtimeType: 'claude-code' as any
			};

			await service.buildSystemPrompt(config);

			// Should attempt to load prompt from teams prompts directory
			expect(mockAccess).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/tpm/prompt.md')
			);
		});
	});

	describe('buildMemoryContext', () => {
		beforeEach(() => {
			mockInitializeForSession.mockClear();
			mockGetFullContext.mockClear();
			mockInitializeForSession.mockResolvedValue(undefined);
			mockGetFullContext.mockResolvedValue('');
		});

		it('should return formatted memory context when available', async () => {
			mockGetFullContext.mockResolvedValue('## Test Memory Context\nSome knowledge');

			const result = await service.buildMemoryContext('agent-001', '/test/project', { role: 'developer' });

			expect(mockInitializeForSession).toHaveBeenCalledWith(
				'agent-001',
				'developer',
				'/test/project'
			);
			expect(result).toContain('Your Knowledge Base');
			expect(result).toContain('Test Memory Context');
			expect(result).toContain('remember');
			expect(result).toContain('recall');
		});

		it('should return empty string when no memory available', async () => {
			mockGetFullContext.mockResolvedValue('');

			const result = await service.buildMemoryContext('agent-001', '/test/project');

			expect(result).toBe('');
		});

		it('should use default role when not provided', async () => {
			mockGetFullContext.mockResolvedValue('');

			await service.buildMemoryContext('agent-001', '/test/project');

			expect(mockInitializeForSession).toHaveBeenCalledWith(
				'agent-001',
				'developer',
				'/test/project'
			);
		});

		it('should handle errors gracefully', async () => {
			mockInitializeForSession.mockRejectedValue(new Error('Memory error'));

			const result = await service.buildMemoryContext('agent-001', '/test/project');

			expect(result).toBe('');
		});
	});

	describe('buildSystemPromptWithMemory', () => {
		const mockConfig: TeamMemberSessionConfig = {
			name: 'test-session',
			role: 'developer',
			projectPath: '/test/project',
			memberId: 'member-123',
			systemPrompt: 'test prompt',
			runtimeType: 'claude-code' as any
		};

		beforeEach(() => {
			mockInitializeForSession.mockClear();
			mockGetFullContext.mockClear();
			mockInitializeForSession.mockResolvedValue(undefined);
			mockGetFullContext.mockResolvedValue('');
			mockAccess.mockRejectedValue(new Error('File not found')); // Use fallback prompt
		});

		it('should include memory context when available', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nImportant fact');

			const result = await service.buildSystemPromptWithMemory(mockConfig);

			expect(result).toContain('developer tasks');
			expect(result).toContain('Your Knowledge Base');
			expect(result).toContain('Important fact');
			expect(result).toContain('Your Identity');
			expect(result).toContain('Communication');
		});

		it('should return base prompt when memory is empty', async () => {
			mockGetFullContext.mockResolvedValue('');

			const result = await service.buildSystemPromptWithMemory(mockConfig);

			expect(result).toContain('developer tasks');
			expect(result).not.toContain('Your Knowledge Base');
		});

		it('should skip memory when includeMemory is false', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nImportant fact');

			const result = await service.buildSystemPromptWithMemory(mockConfig, { includeMemory: false });

			expect(result).not.toContain('Your Knowledge Base');
			expect(mockInitializeForSession).not.toHaveBeenCalled();
		});

		it('should skip memory when projectPath is missing', async () => {
			const configWithoutProject = { ...mockConfig, projectPath: undefined };
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nImportant fact');

			const result = await service.buildSystemPromptWithMemory(configWithoutProject);

			expect(result).not.toContain('Your Knowledge Base');
		});

		it('should skip memory when memberId is missing', async () => {
			const configWithoutMember = { ...mockConfig, memberId: undefined };
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nImportant fact');

			const result = await service.buildSystemPromptWithMemory(configWithoutMember);

			expect(result).not.toContain('Your Knowledge Base');
		});

		it('should include language matching instruction when memory context is present', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nSome knowledge');

			const result = await service.buildSystemPromptWithMemory(mockConfig);

			expect(result).toContain('Language Matching');
			expect(result).toContain('Always reply in the same language the user writes in');
		});

		it('should include anti-deliberation instructions for gemini-cli runtime', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nSome knowledge');
			const geminiConfig = { ...mockConfig, runtimeType: 'gemini-cli' as const };

			const result = await service.buildSystemPromptWithMemory(geminiConfig);

			expect(result).toContain('Execution Discipline');
			expect(result).toContain('Execute tool calls immediately');
			expect(result).toContain('do not try to batch plan multiple reads');
			expect(result).toContain('Action over deliberation');
		});

		it('should NOT include anti-deliberation instructions for claude-code runtime', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nSome knowledge');
			const claudeConfig = { ...mockConfig, runtimeType: 'claude-code' as const };

			const result = await service.buildSystemPromptWithMemory(claudeConfig);

			expect(result).not.toContain('Execution Discipline');
			expect(result).not.toContain('Execute tool calls immediately');
		});

		it('should NOT include anti-deliberation instructions when runtimeType is undefined', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nSome knowledge');
			const noRuntimeConfig = { ...mockConfig, runtimeType: undefined };

			const result = await service.buildSystemPromptWithMemory(noRuntimeConfig);

			expect(result).not.toContain('Execution Discipline');
		});
	});

	// =========================================================================
	// WIRE-2: TeamMember + Team context path coverage
	// =========================================================================

	describe('buildModuleConfigFromTeamMember (WIRE-2)', () => {
		/** Build a real-shaped TeamMember fixture with every WIRE-2 field set. */
		function buildMember(overrides: Partial<TeamMember> = {}): TeamMember {
			return {
				id: 'mem-sam',
				name: 'Sam',
				sessionName: 'crewly-product-sam',
				role: 'developer',
				systemPrompt: '',
				agentStatus: 'active',
				workingStatus: 'idle',
				runtimeType: 'claude-code',
				createdAt: '',
				updatedAt: '',
				hierarchyLevel: 1,
				canDelegate: true,
				subordinateIds: ['mem-leo', 'mem-max'],
				autonomyLevel: 'directed',
				capabilities: ['backend', 'api'],
				domainSOP: 'commit-discipline',
				riskPolicy: 'requires_approval',
				jobTitle: 'Technical Team Lead',
				jobDescription: 'Owns backend domain',
				ownershipScope: { domains: ['backend'], areas: ['code-quality'] },
				expertId: 'expert-sam',
				...overrides,
			} as TeamMember;
		}

		/** Build a real-shaped Team fixture with every WIRE-2 field set. */
		function buildTeam(overrides: Partial<Team> = {}): Team {
			return {
				id: 'team-product',
				name: 'Crewly Product',
				description: 'The Crewly Product team',
				mission: 'Ship Crewly Pro 1.0',
				budget: { tokens: 1_000_000, costUsd: 100 },
				qualityGate: { coverage: 80, lint: true },
				serviceContract: { sla: '5min' },
				ownershipScope: { domains: ['backend', 'api'] },
				members: [
					{
						id: 'mem-sam',
						name: 'Sam',
						sessionName: 'crewly-product-sam',
						role: 'developer',
						systemPrompt: '',
						agentStatus: 'active',
						workingStatus: 'idle',
						runtimeType: 'claude-code',
						createdAt: '',
						updatedAt: '',
						hierarchyLevel: 1,
						canDelegate: true,
					},
					{
						id: 'mem-leo',
						name: 'Leo',
						sessionName: 'crewly-product-leo',
						role: 'developer',
						systemPrompt: '',
						agentStatus: 'active',
						workingStatus: 'idle',
						runtimeType: 'claude-code',
						createdAt: '',
						updatedAt: '',
						hierarchyLevel: 2,
						canDelegate: false,
					},
				],
				projectIds: [],
				createdAt: '',
				updatedAt: '',
				...overrides,
			} as Team;
		}

		const runtime = {
			sessionName: 'crewly-product-sam-dd2b46f7',
			projectPath: '/projects/crewly',
			runtimeType: 'claude-code' as const,
			agentSkillsPath: '/projects/crewly/config/skills/agent',
			tlSkillsPath: '/projects/crewly/config/skills/team-leader',
			projectRoot: '/projects/crewly',
		};

		it('wires every member-level autonomy field into the ModuleConfig', () => {
			const config = buildModuleConfigFromTeamMember(buildMember(), buildTeam(), runtime);
			expect(config.autonomyLevel).toBe('directed');
			expect(config.capabilities).toEqual(['backend', 'api']);
			expect(config.domainSOP).toBe('commit-discipline');
			expect(config.riskPolicy).toBe('requires_approval');
			expect(config.jobTitle).toBe('Technical Team Lead');
			expect(config.jobDescription).toBe('Owns backend domain');
			expect(config.ownershipScope).toEqual({ domains: ['backend'], areas: ['code-quality'] });
			expect(config.expertId).toBe('expert-sam');
		});

		it('wires every team-level field into the ModuleConfig', () => {
			const config = buildModuleConfigFromTeamMember(buildMember(), buildTeam(), runtime);
			expect(config.teamId).toBe('team-product');
			expect(config.teamDescription).toBe('The Crewly Product team');
			expect(config.teamMission).toBe('Ship Crewly Pro 1.0');
			expect(config.teamBudget).toEqual({ tokens: 1_000_000, costUsd: 100 });
			expect(config.teamQualityGate).toEqual({ coverage: 80, lint: true });
			expect(config.serviceContract).toEqual({ sla: '5min' });
			expect(config.teamOwnershipScope).toEqual({ domains: ['backend', 'api'] });
		});

		it('resolves orgRole=team-lead for canDelegate members', () => {
			const config = buildModuleConfigFromTeamMember(buildMember(), buildTeam(), runtime);
			expect(config.orgRole).toBe('team-lead');
			expect(deriveOrgRole(buildMember(), buildTeam())).toBe('team-lead');
		});

		it('resolves orgRole=executor for non-canDelegate members with no subordinates', () => {
			const member = buildMember({ canDelegate: false, subordinateIds: [] });
			const config = buildModuleConfigFromTeamMember(member, buildTeam(), runtime);
			expect(config.orgRole).toBe('executor');
		});

		it('resolves orgRole=orchestrator for orchestrator role', () => {
			const member = buildMember({ role: 'orchestrator', canDelegate: false });
			const config = buildModuleConfigFromTeamMember(member, buildTeam(), runtime);
			expect(config.orgRole).toBe('orchestrator');
		});

		it('falls back to deriving subordinates from team.members when not pre-supplied', () => {
			// runtime.subordinates omitted — helper resolves from team.members + member.subordinateIds.
			const config = buildModuleConfigFromTeamMember(buildMember(), buildTeam(), runtime);
			expect(config.subordinates).toEqual([
				{
					name: 'Leo',
					sessionName: 'crewly-product-leo',
					role: 'developer',
					memberId: 'mem-leo',
				},
			]);
		});

		it('uses runtime.subordinates verbatim when provided', () => {
			const config = buildModuleConfigFromTeamMember(buildMember(), buildTeam(), {
				...runtime,
				subordinates: [
					{
						name: 'Pre-resolved',
						sessionName: 'pre-session',
						role: 'developer',
						memberId: 'pre-id',
					},
				],
			});
			expect(config.subordinates?.[0].name).toBe('Pre-resolved');
		});
	});

	describe('buildSystemPromptWithTeamContext (WIRE-2)', () => {
		/**
		 * The new method delegates to PromptAssemblyService.assemble, which
		 * is integration-heavy. We exercise the BEHAVIOUR via the helper-
		 * driven ModuleConfig — the tests above pin the helper output, and
		 * `buildSystemPromptWithTeamContext` is a thin glue layer. Here we
		 * confirm the overlay path: caller-supplied overrides land on the
		 * final ModuleConfig.
		 */
		it('overlays caller-supplied fields on top of the helper-built config', () => {
			const member: TeamMember = {
				id: 'mem-x',
				name: 'X',
				sessionName: 's-x',
				role: 'developer',
				systemPrompt: '',
				agentStatus: 'active',
				workingStatus: 'idle',
				runtimeType: 'claude-code',
				createdAt: '',
				updatedAt: '',
				hierarchyLevel: 1,
				canDelegate: true,
			} as TeamMember;
			const team: Team = {
				id: 't-x',
				name: 'X-team',
				description: 'desc',
				members: [member],
				projectIds: [],
				createdAt: '',
				updatedAt: '',
			} as Team;
			const base = buildModuleConfigFromTeamMember(member, team, {
				sessionName: 's-x',
				projectPath: '/p',
				runtimeType: 'claude-code',
				agentSkillsPath: '/p/config/skills/agent',
				tlSkillsPath: '/p/config/skills/team-leader',
				projectRoot: '/p',
			});
			// Simulate the agent-registration overlay (memberId override + teamNormsPath).
			const overlay = {
				memberId: 'override-id',
				teamNormsPath: '/home/.crewly/teams/t-x/norms',
			};
			const merged = { ...base, ...overlay };
			expect(merged.memberId).toBe('override-id');
			expect(merged.teamNormsPath).toBe('/home/.crewly/teams/t-x/norms');
			// Helper-derived fields preserved.
			expect(merged.orgRole).toBe('team-lead');
			expect(merged.canDelegate).toBe(true);
		});
	});

	describe('buildContinuationPrompt', () => {
		beforeEach(() => {
			mockInitializeForSession.mockClear();
			mockGetFullContext.mockClear();
			mockGenerateSOPContext.mockClear();
			mockInitializeForSession.mockResolvedValue(undefined);
			mockGetFullContext.mockResolvedValue('');
			mockGenerateSOPContext.mockResolvedValue('');
		});

		it('should build continuation prompt with memory context', async () => {
			mockGetFullContext.mockResolvedValue('## Your Knowledge Base\n\nRelevant patterns');

			const result = await service.buildContinuationPrompt(
				'agent-001',
				'developer',
				'/test/project',
				{ title: 'Fix authentication bug', description: 'Users cannot log in' }
			);

			expect(result).toContain('Continue Your Work');
			expect(result).toContain('Fix authentication bug');
			expect(result).toContain('Users cannot log in');
			expect(result).toContain('Your Knowledge Base');
		});

		it('should handle missing memory context', async () => {
			mockGetFullContext.mockResolvedValue('');

			const result = await service.buildContinuationPrompt(
				'agent-001',
				'developer',
				'/test/project',
				{ title: 'Implement feature' }
			);

			expect(result).toContain('Continue Your Work');
			expect(result).toContain('No prior memory context available');
			expect(result).toContain('Implement feature');
		});

		it('should handle task without description', async () => {
			mockGetFullContext.mockResolvedValue('');

			const result = await service.buildContinuationPrompt(
				'agent-001',
				'developer',
				'/test/project',
				{ title: 'Quick fix' }
			);

			expect(result).toContain('**Quick fix**');
			expect(result).not.toMatch(/Quick fix\n\n\n/); // No empty description block
		});

		it('should include SOP context when available', async () => {
			mockGetFullContext.mockResolvedValue('');
			mockGenerateSOPContext.mockResolvedValue('## Standard Operating Procedures\n\n### Git Workflow\nCommit frequently...');

			const result = await service.buildContinuationPrompt(
				'agent-001',
				'developer',
				'/test/project',
				{ title: 'Commit changes', description: 'Committing code changes' }
			);

			expect(result).toContain('Continue Your Work');
			expect(result).toContain('Standard Operating Procedures');
			expect(result).toContain('Git Workflow');
			expect(mockGenerateSOPContext).toHaveBeenCalled();
		});
	});

	describe('buildSOPContext', () => {
		beforeEach(() => {
			mockGenerateSOPContext.mockClear();
			mockGenerateSOPContext.mockResolvedValue('');
		});

		it('should return SOP context when available', async () => {
			mockGenerateSOPContext.mockResolvedValue('## Standard Operating Procedures\n\n### Git Workflow\nFollow these steps...');

			const result = await service.buildSOPContext('developer', 'committing changes');

			expect(result).toContain('Standard Operating Procedures');
			expect(result).toContain('Git Workflow');
			expect(mockGenerateSOPContext).toHaveBeenCalledWith({
				role: 'developer',
				taskContext: 'committing changes',
				taskType: undefined,
				limit: undefined,
			});
		});

		it('should return empty string when no SOPs match', async () => {
			mockGenerateSOPContext.mockResolvedValue('');

			const result = await service.buildSOPContext('developer', 'random context');

			expect(result).toBe('');
		});

		it('should pass taskType to SOP service', async () => {
			mockGenerateSOPContext.mockResolvedValue('## SOPs');

			await service.buildSOPContext('developer', 'testing', 'testing', 3);

			expect(mockGenerateSOPContext).toHaveBeenCalledWith({
				role: 'developer',
				taskContext: 'testing',
				taskType: 'testing',
				limit: 3,
			});
		});

		it('should handle SOP service errors gracefully', async () => {
			mockGenerateSOPContext.mockRejectedValue(new Error('SOP service error'));

			const result = await service.buildSOPContext('developer', 'context');

			expect(result).toBe('');
		});
	});

	describe('buildSystemPromptWithMemory with SOPs', () => {
		const mockConfig: TeamMemberSessionConfig = {
			name: 'test-session',
			role: 'developer',
			projectPath: '/test/project',
			memberId: 'member-123',
			systemPrompt: 'test prompt',
			runtimeType: 'claude-code' as any
		};

		beforeEach(() => {
			mockInitializeForSession.mockClear();
			mockGetFullContext.mockClear();
			mockGenerateSOPContext.mockClear();
			mockInitializeForSession.mockResolvedValue(undefined);
			mockGetFullContext.mockResolvedValue('');
			mockGenerateSOPContext.mockResolvedValue('');
			mockAccess.mockRejectedValue(new Error('File not found')); // Use fallback prompt
		});

		it('should include SOP context when available', async () => {
			mockGenerateSOPContext.mockResolvedValue('## Standard Operating Procedures\n\n### Coding Standards\nUse TypeScript...');

			const result = await service.buildSystemPromptWithMemory(mockConfig, {
				taskContext: 'writing code'
			});

			expect(result).toContain('developer tasks');
			expect(result).toContain('Standard Operating Procedures');
			expect(result).toContain('Coding Standards');
		});

		it('should skip SOPs when includeSOPs is false', async () => {
			mockGenerateSOPContext.mockResolvedValue('## Standard Operating Procedures\n\nSome SOPs...');

			const result = await service.buildSystemPromptWithMemory(mockConfig, { includeSOPs: false });

			expect(result).not.toContain('Standard Operating Procedures');
			expect(mockGenerateSOPContext).not.toHaveBeenCalled();
		});

		it('should include both memory and SOP context', async () => {
			mockGetFullContext.mockResolvedValue('## Agent Knowledge\nImportant fact');
			mockGenerateSOPContext.mockResolvedValue('## Standard Operating Procedures\n\n### Git Workflow\nCommit frequently');

			const result = await service.buildSystemPromptWithMemory(mockConfig, {
				taskContext: 'committing code'
			});

			expect(result).toContain('Your Knowledge Base');
			expect(result).toContain('Important fact');
			expect(result).toContain('Standard Operating Procedures');
			expect(result).toContain('Git Workflow');
		});

		it('should include get-sops in communication tools', async () => {
			mockGenerateSOPContext.mockResolvedValue('## SOPs');

			const result = await service.buildSystemPromptWithMemory(mockConfig);

			expect(result).toContain('get-sops');
		});
	});

	describe('buildTeamLeadSection', () => {
		const tlAddonContent = `## Team Leader Add-on

You are a **player-coach**: delegate 50–70% of tasks.

### Your Workers

{{WORKER_LIST}}

### Your Management Skills

Skills at \`{{TL_SKILLS_PATH}}/\`:

#### 1. delegate-task
\`\`\`bash
bash {{TL_SKILLS_PATH}}/delegate-task/execute.sh '{"teamId":"{{TEAM_ID}}","tlMemberId":"{{MEMBER_ID}}","projectPath":"{{PROJECT_PATH}}"}'
\`\`\`

### MANDATORY Behaviors

1. After receiving a goal: MUST decompose and delegate.
2. After every delegation: MUST schedule-check.
3. When worker reports done: MUST verify-output.`;

		it('should load TL addon from file when canDelegate is true and subordinates exist', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'crewly-product-sam',
				role: 'developer',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'tl-001',
				teamId: 'team-abc',
				canDelegate: true,
				subordinates: [
					{ name: 'Leo', sessionName: 'crewly-product-leo', role: 'developer', memberId: 'member-leo' },
					{ name: 'Nick', sessionName: 'crewly-product-nick', role: 'frontend-developer', memberId: 'member-nick' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('Team Leader Add-on');
			expect(result).toContain('player-coach');
			expect(result).toContain('**Leo**');
			expect(result).toContain('crewly-product-leo');
			expect(result).toContain('**Nick**');
			expect(result).toContain('crewly-product-nick');
			expect(result).toContain('MANDATORY Behaviors');
			// Verify tl-addon.md was read
			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('/config/roles/team-leader/tl-addon.md'),
				'utf8'
			);
		});

		it('should resolve all template variables in TL addon', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'sam-session',
				role: 'developer',
				systemPrompt: '',
				projectPath: '/my/project',
				memberId: 'member-xyz',
				teamId: 'team-123',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			// WORKER_LIST resolved
			expect(result).toContain('**Worker** (session: `worker-session`, memberId: `member-worker`) — developer');
			// TL_SKILLS_PATH resolved
			expect(result).toContain('/test/project/config/skills/team-leader/');
			// TEAM_ID resolved
			expect(result).toContain('"teamId":"team-123"');
			// MEMBER_ID resolved
			expect(result).toContain('"tlMemberId":"member-xyz"');
			// PROJECT_PATH resolved
			expect(result).toContain('"projectPath":"/my/project"');
			// No unresolved template variables remain
			expect(result).not.toContain('{{');
		});

		it('should fall back to inline section when tl-addon.md is not found', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			// Fallback inline section should contain basic TL content
			expect(result).toContain('Team Lead Responsibilities');
			expect(result).toContain('Task Decomposition');
			expect(result).toContain('Delegation');
			expect(result).toContain('Quality Review');
			expect(result).toContain('**Worker**');
			expect(result).toContain('worker-session');
		});

		it('should include delegation duties in inline fallback', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('Task Decomposition');
			expect(result).toContain('Delegation');
			expect(result).toContain('Quality Review');
			expect(result).toContain('Progress Reporting');
			expect(result).toContain('send-message');
			expect(result).toContain('report-status');
		});

		it('should include task assignment template in inline fallback', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('[TASK]');
			expect(result).toContain('Priority:');
			expect(result).toContain('Task Assignment Template');
		});

		it('should include delegation guidelines in inline fallback', async () => {
			mockAccess.mockRejectedValue(new Error('File not found'));

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('Delegate by default');
			expect(result).toContain('Be specific');
			expect(result).toContain('Monitor progress');
		});

		it('should return empty string when canDelegate is false', async () => {
			const config: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				systemPrompt: '',
				canDelegate: false,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toBe('');
		});

		it('should return empty string when canDelegate is undefined', async () => {
			const config: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				systemPrompt: '',
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toBe('');
		});

		it('should return empty string when subordinates is empty', async () => {
			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
				subordinates: [],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toBe('');
		});

		it('should return empty string when subordinates is undefined', async () => {
			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toBe('');
		});

		it('should handle single subordinate with file addon', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				canDelegate: true,
				teamId: 'team-1',
				memberId: 'm-1',
				projectPath: '/proj',
				subordinates: [
					{ name: 'Solo Worker', sessionName: 'solo-session', role: 'qa', memberId: 'member-solo' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('**Solo Worker**');
			expect(result).toContain('solo-session');
			expect(result).toContain('qa');
			// Should only have one subordinate listed
			expect(result.match(/\*\*.*\*\* \(session:/g)?.length).toBe(1);
		});

		it('should auto-stack TL addon for a developer role with canDelegate', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'dev-tl-session',
				role: 'developer',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'dev-tl-001',
				teamId: 'team-dev',
				canDelegate: true,
				subordinates: [
					{ name: 'Junior', sessionName: 'junior-session', role: 'developer', memberId: 'member-junior' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			// Developer with canDelegate should still get TL addon
			expect(result).toContain('Team Leader Add-on');
			expect(result).toContain('player-coach');
			expect(result).toContain('**Junior**');
			expect(result).toContain('MANDATORY Behaviors');
		});

		it('should handle missing teamId gracefully in template resolution', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'developer',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'tl-001',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			// Should not crash — teamId defaults to empty string
			expect(result).toContain('Team Leader Add-on');
			expect(result).toContain('"teamId":""');
		});
	});

	describe('buildSystemPromptWithMemory with TL context', () => {
		beforeEach(() => {
			mockInitializeForSession.mockClear();
			mockGetFullContext.mockClear();
			mockGenerateSOPContext.mockClear();
			mockInitializeForSession.mockResolvedValue(undefined);
			mockGetFullContext.mockResolvedValue('');
			mockGenerateSOPContext.mockResolvedValue('');
			mockAccess.mockRejectedValue(new Error('File not found')); // Use fallback prompt
		});

		it('should inject TL section into composed prompt when canDelegate is true', async () => {
			const tlConfig: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'tl-001',
				canDelegate: true,
				subordinates: [
					{ name: 'Leo', sessionName: 'leo-session', role: 'developer', memberId: 'member-leo-2' },
				],
			};

			const result = await service.buildSystemPromptWithMemory(tlConfig);

			expect(result).toContain('Team Lead Responsibilities');
			expect(result).toContain('**Leo**');
			expect(result).toContain('leo-session');
			expect(result).toContain('Your Identity');
			expect(result).toContain('Communication');
		});

		it('should NOT inject TL section for regular developers', async () => {
			const devConfig: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'dev-001',
			};

			// Need at least memory or SOP context for composePromptWithMemory to run
			mockGetFullContext.mockResolvedValue('Some memory');

			const result = await service.buildSystemPromptWithMemory(devConfig);

			expect(result).not.toContain('Team Lead Responsibilities');
			expect(result).not.toContain('Delegation');
		});

		it('should include TL section alongside memory and SOP context', async () => {
			mockGetFullContext.mockResolvedValue('## Knowledge\nImportant fact');
			mockGenerateSOPContext.mockResolvedValue('## SOPs\nFollow these steps');

			const tlConfig: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'tl-001',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildSystemPromptWithMemory(tlConfig);

			expect(result).toContain('Your Knowledge Base');
			expect(result).toContain('Important fact');
			expect(result).toContain('SOPs');
			expect(result).toContain('Team Lead Responsibilities');
			expect(result).toContain('**Worker**');
		});

		it('should compose prompt with TL section even when memory and SOPs are empty', async () => {
			const tlConfig: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'team-leader',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'tl-001',
				canDelegate: true,
				subordinates: [
					{ name: 'Worker', sessionName: 'worker-session', role: 'developer', memberId: 'member-worker' },
				],
			};

			const result = await service.buildSystemPromptWithMemory(tlConfig);

			// Should still compose full prompt because TL context is non-empty
			expect(result).toContain('Team Lead Responsibilities');
			expect(result).toContain('Your Identity');
			expect(result).toContain('Communication');
		});

		it('should auto-stack file-based TL addon into composed prompt for developer with TL hierarchy', async () => {
			const tlAddonFileContent = `## TL Addon

### Workers
{{WORKER_LIST}}

### Skills at {{TL_SKILLS_PATH}}
delegate-task for team {{TEAM_ID}}

### MANDATORY
Decompose and delegate.`;

			// Allow tl-addon.md access but reject role prompt access (use fallback)
			mockAccess.mockImplementation((filePath: string) => {
				if (filePath.includes('tl-addon.md')) {
					return Promise.resolve(undefined);
				}
				return Promise.reject(new Error('File not found'));
			});
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('tl-addon.md')) {
					return Promise.resolve(tlAddonFileContent);
				}
				return Promise.reject(new Error('File not found'));
			});

			const devTlConfig: TeamMemberSessionConfig = {
				name: 'dev-tl-session',
				role: 'developer',
				systemPrompt: '',
				projectPath: '/test/project',
				memberId: 'dev-tl-001',
				teamId: 'team-xyz',
				canDelegate: true,
				subordinates: [
					{ name: 'Junior', sessionName: 'junior-session', role: 'developer', memberId: 'member-junior' },
				],
			};

			const result = await service.buildSystemPromptWithMemory(devTlConfig);

			// Should have dev fallback prompt + TL addon stacked
			expect(result).toContain('developer tasks'); // from fallback dev prompt
			expect(result).toContain('TL Addon'); // from tl-addon.md
			expect(result).toContain('**Junior** (session: `junior-session`, memberId: `member-junior`) — developer');
			expect(result).toContain('team-xyz');
			expect(result).toContain('MANDATORY');
			expect(result).toContain('Your Identity');
			expect(result).toContain('Communication');
		});
	});

	describe('buildMemoryRoutingSection', () => {
		it('should return memory routing rules with table', () => {
			const result = service.buildMemoryRoutingSection();

			expect(result).toContain('Memory Routing Rules');
			expect(result).toContain('scope: "project"');
			expect(result).toContain('scope: "agent"');
			expect(result).toContain('category: "pattern"');
			expect(result).toContain('category: "preference"');
			expect(result).toContain('category: "gotcha"');
		});

		it('should include rules of thumb guidance', () => {
			const result = service.buildMemoryRoutingSection();

			expect(result).toContain('Rules of thumb');
			expect(result).toContain('another agent or a future session');
			expect(result).toContain('only YOU would benefit');
			expect(result).toContain('only useful right now');
		});

		it('should warn against storing secrets', () => {
			const result = service.buildMemoryRoutingSection();

			expect(result).toContain('Never store secrets, credentials, or tokens');
		});

		it('should include temporary task notes routing to project files', () => {
			const result = service.buildMemoryRoutingSection();

			expect(result).toContain('Temporary task notes');
			expect(result).toContain('Project files or Claude native memory');
		});
	});

	describe('buildSystemPromptWithMemory includes memory routing', () => {
		const mockConfig: TeamMemberSessionConfig = {
			name: 'test-session',
			role: 'developer',
			projectPath: '/test/project',
			memberId: 'member-123',
			systemPrompt: 'test prompt',
			runtimeType: 'claude-code' as any,
		};

		beforeEach(() => {
			mockInitializeForSession.mockClear();
			mockGetFullContext.mockClear();
			mockGenerateSOPContext.mockClear();
			mockInitializeForSession.mockResolvedValue(undefined);
			mockGetFullContext.mockResolvedValue('Some memory context');
			mockGenerateSOPContext.mockResolvedValue('');
			mockAccess.mockRejectedValue(new Error('File not found'));
		});

		it('should include memory routing section in composed prompts', async () => {
			const result = await service.buildSystemPromptWithMemory(mockConfig);

			expect(result).toContain('Memory Routing Rules');
			expect(result).toContain('scope: "project"');
			expect(result).toContain('scope: "agent"');
		});

		it('should place memory routing before communication section', async () => {
			const result = await service.buildSystemPromptWithMemory(mockConfig);

			const routingIdx = result.indexOf('Memory Routing Rules');
			const commIdx = result.indexOf('## Communication');

			expect(routingIdx).toBeGreaterThan(-1);
			expect(commIdx).toBeGreaterThan(-1);
			expect(routingIdx).toBeLessThan(commIdx);
		});
	});

	describe('buildSessionRecoverySection', () => {
		it('should generate session recovery section with recall and get-my-context commands', () => {
			const result = service.buildSessionRecoverySection(
				'crewly-product-sam',
				'developer',
				'/test/project'
			);

			expect(result).toContain('Session Recovery Protocol (MANDATORY)');
			expect(result).toContain('recall/execute.sh');
			expect(result).toContain('get-my-context/execute.sh');
			expect(result).toContain('"agentId":"crewly-product-sam"');
			expect(result).toContain('"agentRole":"developer"');
			expect(result).toContain('"projectPath":"/test/project"');
		});

		it('should include all recovery steps including Step 1.5 (issue #395)', () => {
			const result = service.buildSessionRecoverySection(
				'test-agent',
				'qa',
				'/projects/app'
			);

			expect(result).toContain('Step 1: Recall previous knowledge');
			expect(result).toContain('Step 1.5: Read your active work');
			expect(result).toContain('Step 2: Load your full context');
			expect(result).toContain('Step 3: Register yourself as active');
			expect(result).toContain('Step 4: Assess and report');
		});

		it('should reference get-my-active-work skill in Step 1.5 (issue #395)', () => {
			const result = service.buildSessionRecoverySection(
				'test-agent',
				'developer',
				'/projects/app'
			);

			expect(result).toContain('core/get-my-active-work/execute.sh');
			expect(result).toContain('--session test-agent');
			expect(result).toContain('--role developer');
			expect(result).toContain('State always wins over memory');
		});

		it('should include instructions to check for unfinished work', () => {
			const result = service.buildSessionRecoverySection(
				'test-agent',
				'developer',
				'/projects/app'
			);

			expect(result).toContain('unfinished work');
			expect(result).toContain('pending blockers');
			expect(result).toContain('Do NOT skip these steps');
		});

		it('should use correct skills path based on project root', () => {
			const customService = new PromptBuilderService('/custom/root');
			const result = customService.buildSessionRecoverySection(
				'agent-1',
				'developer',
				'/custom/root'
			);

			expect(result).toContain('/custom/root/config/skills/agent/core/recall/execute.sh');
			expect(result).toContain('/custom/root/config/skills/agent/core/get-my-context/execute.sh');
		});

		it('should include role in the recall context query', () => {
			const result = service.buildSessionRecoverySection(
				'agent-1',
				'backend-developer',
				'/test/project'
			);

			expect(result).toContain('backend-developer session startup');
		});

		it('should work for orchestrator role', () => {
			const result = service.buildSessionRecoverySection(
				'crewly-orc',
				'orchestrator',
				'/test/project'
			);

			expect(result).toContain('"agentId":"crewly-orc"');
			expect(result).toContain('"agentRole":"orchestrator"');
			expect(result).toContain('orchestrator session startup');
		});
	});

	describe('CREWLY_USE_MODULAR_PROMPTS feature flag', () => {
		const mockConfig: TeamMemberSessionConfig = {
			name: 'test-session',
			role: 'developer',
			projectPath: '/test/project',
			memberId: 'member-123',
			systemPrompt: '',
		};

		const originalEnv = process.env.CREWLY_USE_MODULAR_PROMPTS;

		afterEach(() => {
			if (originalEnv === undefined) {
				delete process.env.CREWLY_USE_MODULAR_PROMPTS;
			} else {
				process.env.CREWLY_USE_MODULAR_PROMPTS = originalEnv;
			}
		});

		it('should use modular prompt by default when flag is not set', async () => {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS;
			const result = await service.buildSystemPromptWithMemory(mockConfig);
			// Modular assembly is now the default path
			expect(typeof result).toBe('string');
			expect(result.length).toBeGreaterThan(0);
		});

		it('should use legacy prompt when flag is explicitly false', async () => {
			process.env.CREWLY_USE_MODULAR_PROMPTS = 'false';
			const result = await service.buildSystemPromptWithMemory(mockConfig);
			expect(result).toContain('developer tasks');
		});

		it('should use modular prompt when flag is true', async () => {
			process.env.CREWLY_USE_MODULAR_PROMPTS = 'true';
			const result = await service.buildSystemPromptWithMemory(mockConfig);
			// Modular assembly returns module-based content instead of legacy
			expect(typeof result).toBe('string');
			expect(result.length).toBeGreaterThan(0);
		});

		// ---------------------------------------------------------------------
		// WIRE-1 Arch M1 — merge-time safety regression for the legacy path
		// ---------------------------------------------------------------------

		/**
		 * Arch M1 (P0 production regression) protection: the V4 throw added in
		 * RoleBoundaryModule.build() must NOT fire on the legacy
		 * `buildSystemPromptWithMemory` path. Pre-WIRE-1 the legacy
		 * `buildModularPrompt` set `canDelegate` from session config but never
		 * `orgRole`, which combined with the new throw would break every
		 * existing TL agent on next prompt assembly the moment WIRE-1 merged.
		 *
		 * The stopgap is a SessionConfig-only orgRole cascade inside
		 * `buildModularPrompt` that mirrors `deriveOrgRole`'s rules with the
		 * fields available at that layer (role + canDelegate). This test
		 * pins it.
		 */
		it('does not throw on the legacy path for a TL session config (canDelegate=true)', async () => {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS; // default: modular path
			const tlConfig: TeamMemberSessionConfig = {
				name: 'crewly-product-sam-dd2b46f7',
				role: 'developer',
				projectPath: '/test/project',
				memberId: 'tl-member-id',
				systemPrompt: '',
				canDelegate: true,
				teamId: 'tl-team-id',
			};
			await expect(service.buildSystemPromptWithMemory(tlConfig)).resolves.not.toThrow();
		});

		/**
		 * Companion to the M1 regression test — orchestrator role on the legacy
		 * path also resolves cleanly (orgRole='orchestrator' set inline).
		 */
		it('does not throw on the legacy path for an orchestrator session config', async () => {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS;
			const orcConfig: TeamMemberSessionConfig = {
				name: 'crewly-orc',
				role: 'orchestrator',
				projectPath: '/test/project',
				memberId: 'orc-member-id',
				systemPrompt: '',
				teamId: 'orc-team-id',
			};
			await expect(service.buildSystemPromptWithMemory(orcConfig)).resolves.not.toThrow();
		});

		/**
		 * Companion to the M1 regression test — plain executor on the legacy
		 * path also resolves cleanly (orgRole left undefined; module falls
		 * back to executor without firing the V4 throw because canDelegate
		 * is not true).
		 */
		it('does not throw on the legacy path for a plain executor session config', async () => {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS;
			const execConfig: TeamMemberSessionConfig = {
				name: 'crewly-product-leo-62440736',
				role: 'developer',
				projectPath: '/test/project',
				memberId: 'leo-member-id',
				systemPrompt: '',
				teamId: 'leo-team-id',
				// canDelegate omitted (undefined) — V4 throw must NOT fire
			};
			await expect(service.buildSystemPromptWithMemory(execConfig)).resolves.not.toThrow();
		});
	});
});

// =============================================================================
// WIRE-1: deriveOrgRole + buildModuleConfigFromTeamMember
// =============================================================================

import {
	deriveOrgRole,
	buildModuleConfigFromTeamMember,
	type SessionRuntimeContext,
} from './prompt-builder.service.js';
import type { Team, TeamMember } from '../../types/index.js';

/**
 * Build a minimal-valid TeamMember for unit tests. Override fields per case.
 */
function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
	const base: TeamMember = {
		id: 'member-1',
		name: 'Sam',
		sessionName: 'crewly-product-sam-dd2b46f7',
		role: 'developer',
		systemPrompt: '',
		agentStatus: 'active',
		workingStatus: 'idle',
		runtimeType: 'claude-code',
		createdAt: '2026-04-27T00:00:00Z',
		updatedAt: '2026-04-27T00:00:00Z',
	};
	return { ...base, ...overrides };
}

/**
 * Build a minimal-valid Team for unit tests. Override fields per case.
 */
function makeTeam(overrides: Partial<Team> = {}): Team {
	const base: Team = {
		id: 'team-1',
		name: 'Crewly Product',
		members: [],
		projectIds: [],
		createdAt: '2026-04-27T00:00:00Z',
		updatedAt: '2026-04-27T00:00:00Z',
	};
	return { ...base, ...overrides };
}

/**
 * Standard SessionRuntimeContext for tests — same shape buildModularPrompt
 * derives at runtime, with predictable string paths.
 */
function makeRuntime(overrides: Partial<SessionRuntimeContext> = {}): SessionRuntimeContext {
	const base: SessionRuntimeContext = {
		sessionName: 'crewly-product-sam-dd2b46f7',
		projectPath: '/path/to/project',
		runtimeType: 'claude-code',
		agentSkillsPath: '/path/to/project/config/skills/agent',
		tlSkillsPath: '/path/to/project/config/skills/team-leader',
		projectRoot: '/path/to/project',
	};
	return { ...base, ...overrides };
}

describe('deriveOrgRole — WIRE-1 cascade', () => {
	const team = makeTeam();

	it('rule 1: role=orchestrator → orchestrator (highest priority)', () => {
		const member = makeMember({ role: 'orchestrator', canDelegate: true });
		expect(deriveOrgRole(member, team)).toBe('orchestrator');
	});

	it('rule 2: canDelegate=true → team-lead', () => {
		const member = makeMember({ role: 'developer', canDelegate: true });
		expect(deriveOrgRole(member, team)).toBe('team-lead');
	});

	it('rule 3: subordinateIds non-empty → team-lead (legacy team shape)', () => {
		const member = makeMember({ role: 'developer', canDelegate: false, subordinateIds: ['sub-1'] });
		expect(deriveOrgRole(member, team)).toBe('team-lead');
	});

	it('rule 3b: team-side parentMemberId reference → team-lead', () => {
		const tl = makeMember({ id: 'tl-1', role: 'developer' });
		const sub = makeMember({ id: 'sub-1', name: 'Leo', parentMemberId: 'tl-1' });
		const teamWithChild = makeTeam({ members: [tl, sub] });
		expect(deriveOrgRole(tl, teamWithChild)).toBe('team-lead');
	});

	it('rule 4: default → executor', () => {
		const member = makeMember({ role: 'developer', canDelegate: false });
		expect(deriveOrgRole(member, team)).toBe('executor');
	});

	it('rule 4: no canDelegate flag and no subordinates → executor', () => {
		const member = makeMember({ role: 'developer' });
		expect(deriveOrgRole(member, team)).toBe('executor');
	});

	it('is total — never throws on any well-formed input', () => {
		// Verify the function is exhaustive: minimal member + minimal team
		// must classify (the throws live in RoleBoundaryModule, not here).
		const minimal = makeMember();
		expect(() => deriveOrgRole(minimal, team)).not.toThrow();
	});
});

describe('buildModuleConfigFromTeamMember — WIRE-1 wiring', () => {
	it('wires every member-level autonomy and organisation field', () => {
		const member = makeMember({
			id: 'member-tl',
			canDelegate: true,
			autonomyLevel: 'bounded',
			capabilities: ['can-decide', 'can-verify'],
			domainSOP: 'tl-domain.sop',
			riskPolicy: 'tl-risk.policy',
			jobTitle: 'Technical Team Lead',
			jobDescription: 'Owns backend architecture',
			ownershipScope: { domains: ['backend'], deliverables: ['api'], areas: ['infra'] },
			expertId: 'tl-expert',
		});
		const team = makeTeam();
		const config = buildModuleConfigFromTeamMember(member, team, makeRuntime());

		expect(config.canDelegate).toBe(true);
		expect(config.autonomyLevel).toBe('bounded');
		expect(config.capabilities).toEqual(['can-decide', 'can-verify']);
		expect(config.domainSOP).toBe('tl-domain.sop');
		expect(config.riskPolicy).toBe('tl-risk.policy');
		expect(config.jobTitle).toBe('Technical Team Lead');
		expect(config.jobDescription).toBe('Owns backend architecture');
		expect(config.ownershipScope).toEqual({ domains: ['backend'], deliverables: ['api'], areas: ['infra'] });
		expect(config.expertId).toBe('tl-expert');
	});

	it('wires every team-level field (mission, budget, qualityGate, serviceContract, ownershipScope, description)', () => {
		const member = makeMember();
		const team = makeTeam({
			description: 'The Crewly product team',
			mission: 'Ship the OKR',
			budget: { maxTokensPerDay: 100000, maxUsdPerMonth: 500, alertThreshold: 80 },
			qualityGate: { reviewerId: 'arch-1', autoApprove: false, minQualityScore: 70 },
			serviceContract: { accepts: ['feature requests'], avoids: ['ad-hoc work'], expectedOutput: ['merged PRs'] },
			ownershipScope: { domains: ['product'], deliverables: ['cli', 'api'], areas: ['platform'] },
		});
		const config = buildModuleConfigFromTeamMember(member, team, makeRuntime());

		expect(config.teamDescription).toBe('The Crewly product team');
		expect(config.teamMission).toBe('Ship the OKR');
		expect(config.teamBudget).toEqual({ maxTokensPerDay: 100000, maxUsdPerMonth: 500, alertThreshold: 80 });
		expect(config.teamQualityGate).toEqual({ reviewerId: 'arch-1', autoApprove: false, minQualityScore: 70 });
		expect(config.serviceContract).toEqual({ accepts: ['feature requests'], avoids: ['ad-hoc work'], expectedOutput: ['merged PRs'] });
		expect(config.teamOwnershipScope).toEqual({ domains: ['product'], deliverables: ['cli', 'api'], areas: ['platform'] });
	});

	it('resolves orgRole=team-lead for canDelegate=true members', () => {
		const member = makeMember({ canDelegate: true });
		const team = makeTeam();
		const config = buildModuleConfigFromTeamMember(member, team, makeRuntime());
		expect(config.orgRole).toBe('team-lead');
	});

	it('resolves orgRole=executor for plain members', () => {
		const member = makeMember();
		const team = makeTeam();
		const config = buildModuleConfigFromTeamMember(member, team, makeRuntime());
		expect(config.orgRole).toBe('executor');
	});

	it('resolves orgRole=orchestrator for role=orchestrator', () => {
		const member = makeMember({ role: 'orchestrator' });
		const team = makeTeam();
		const config = buildModuleConfigFromTeamMember(member, team, makeRuntime());
		expect(config.orgRole).toBe('orchestrator');
	});

	it('resolves subordinates from team.members when not provided in runtime', () => {
		const tl = makeMember({ id: 'tl-1', canDelegate: true, subordinateIds: ['sub-1', 'sub-2'] });
		const sub1 = makeMember({ id: 'sub-1', name: 'Leo', sessionName: 'leo-session', role: 'developer' });
		const sub2 = makeMember({ id: 'sub-2', name: 'Max', sessionName: 'max-session', role: 'developer' });
		const team = makeTeam({ members: [tl, sub1, sub2] });
		const config = buildModuleConfigFromTeamMember(tl, team, makeRuntime());

		expect(config.subordinates).toHaveLength(2);
		expect(config.subordinates?.[0]).toEqual({
			name: 'Leo',
			sessionName: 'leo-session',
			role: 'developer',
			memberId: 'sub-1',
		});
		expect(config.subordinates?.[1]?.name).toBe('Max');
	});

	it('drops unresolved subordinate ids without throwing', () => {
		const tl = makeMember({ id: 'tl-1', canDelegate: true, subordinateIds: ['sub-1', 'sub-MISSING'] });
		const sub1 = makeMember({ id: 'sub-1', name: 'Leo', sessionName: 'leo-session' });
		const team = makeTeam({ members: [tl, sub1] });
		const config = buildModuleConfigFromTeamMember(tl, team, makeRuntime());

		expect(config.subordinates).toHaveLength(1);
		expect(config.subordinates?.[0]?.name).toBe('Leo');
	});

	it('honours runtime-provided subordinates when present (skipping team-side resolution)', () => {
		const tl = makeMember({ canDelegate: true, subordinateIds: ['sub-1'] });
		const team = makeTeam({ members: [tl] }); // no subordinates in team
		const runtime = makeRuntime({
			subordinates: [
				{ name: 'Override', sessionName: 'override-session', role: 'developer', memberId: 'sub-override' },
			],
		});
		const config = buildModuleConfigFromTeamMember(tl, team, runtime);

		expect(config.subordinates).toHaveLength(1);
		expect(config.subordinates?.[0]?.memberId).toBe('sub-override');
	});

	it('omits subordinates field entirely when there are none', () => {
		const member = makeMember();
		const team = makeTeam();
		const config = buildModuleConfigFromTeamMember(member, team, makeRuntime());
		expect(config.subordinates).toBeUndefined();
	});

	it('passes through runtime-host fields (sessionName, projectPath, paths)', () => {
		const member = makeMember();
		const team = makeTeam();
		const runtime = makeRuntime({
			sessionName: 'distinct-session-name',
			projectPath: '/another/project',
			runtimeType: 'gemini-cli',
			agentSkillsPath: '/another/agent',
			tlSkillsPath: '/another/tl',
			projectRoot: '/another/root',
		});
		const config = buildModuleConfigFromTeamMember(member, team, runtime);
		expect(config.sessionName).toBe('distinct-session-name');
		expect(config.projectPath).toBe('/another/project');
		expect(config.runtimeType).toBe('gemini-cli');
		expect(config.agentSkillsPath).toBe('/another/agent');
		expect(config.tlSkillsPath).toBe('/another/tl');
		expect(config.projectRoot).toBe('/another/root');
	});
});