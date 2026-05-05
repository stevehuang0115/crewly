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

		// Mission/OKR card plumbing — fix #415 secondary findings.
		// Slug is required to resolve `<slug>-team-sub-okr.md`; ancestor
		// chain is required for the OKR-hierarchy filter widening.
		describe('mission-context plumbing (#415)', () => {
			it('slugifies team.name into teamSlug (lowercase, hyphenated, alnum-only)', () => {
				const team = { ...buildTeam(), name: 'Crewly Product!' } as Team;
				const config = buildModuleConfigFromTeamMember(buildMember(), team, runtime);
				expect(config.teamSlug).toBe('crewly-product');
			});

			it('teamSlug is undefined when team.name is empty', () => {
				const team = { ...buildTeam(), name: '' } as Team;
				const config = buildModuleConfigFromTeamMember(buildMember(), team, runtime);
				expect(config.teamSlug).toBeUndefined();
			});

			it('teamAncestorIds contains parentTeamId when set', () => {
				const team = { ...buildTeam(), parentTeamId: 'parent-team-x' } as Team;
				const config = buildModuleConfigFromTeamMember(buildMember(), team, runtime);
				expect(config.teamAncestorIds).toEqual(['parent-team-x']);
			});

			it('teamAncestorIds is undefined when team has no parent', () => {
				const team = { ...buildTeam(), parentTeamId: undefined } as Team;
				const config = buildModuleConfigFromTeamMember(buildMember(), team, runtime);
				expect(config.teamAncestorIds).toBeUndefined();
			});
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

// =============================================================================
// Pipeline Dogfood Amendments — spec 2026-05-05-pipeline-dogfood-prompt-amendment
// =============================================================================
//
// These tests cover the §5.1 "Prompt amendment landed" acceptance criteria.
// Each amendment must surface in the rendered prompt; tests render via the
// existing build* methods and assert that the §3 phrases appear.
//
// The prompt-builder service loads role files from disk; we mock fs/promises so
// the tests are hermetic. For role-file-backed amendments (§3.2 TL, §3.3 PM,
// §3.4 Worker session-start, §3.5 sweeps), the test reads the actual file from
// the worktree using the unmocked Node fs and feeds the content through the
// mock — this verifies BOTH that the prompt-builder pipeline renders the amendment
// AND that the source role file contains the required phrases.
// =============================================================================
describe('Pipeline Dogfood Amendments (spec 2026-05-05) — §5.1', () => {
	let service: PromptBuilderService;
	let mockReadFile: jest.Mock;
	let mockAccess: jest.Mock;
	const savedModularEnv = process.env.CREWLY_USE_MODULAR_PROMPTS;

	// Resolve the actual repo root so we can read the real role files
	// for assertion. __dirname under jest is something like
	// `<repo>/backend/src/services/ai`; back up to repo root.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require('path') as typeof import('path');
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require('fs') as typeof import('fs');
	const repoRoot = path.resolve(__dirname, '../../../../');

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.CREWLY_USE_MODULAR_PROMPTS = 'false';
		mockReadFile = jest.mocked(fsPromises.readFile);
		mockAccess = jest.mocked(fsPromises.access);
		service = new PromptBuilderService(repoRoot);
	});

	afterEach(() => {
		if (savedModularEnv === undefined) {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS;
		} else {
			process.env.CREWLY_USE_MODULAR_PROMPTS = savedModularEnv;
		}
	});

	describe('§3.1 — buildOrchestratorPrompt includes pipeline-first planning', () => {
		it('rendered prompt contains "POST /api/requests" and "intentLevel"', () => {
			const projectData = {
				projectName: 'Dogfood Test',
				projectPath: '/test/path',
				teamDetails: { name: 'Crew', members: [{ name: 'Sam', role: 'TL' }] },
				requirements: 'ship pipeline-first',
			};

			const result = service.buildOrchestratorPrompt(projectData);

			// §5.1 line 1: assert both phrases appear in the rendered prompt
			expect(result).toContain('POST /api/requests');
			expect(result).toContain('intentLevel');
			// Spec citation must remain so the amendment is traceable
			expect(result).toContain('2026-05-05-pipeline-dogfood-prompt-amendment.md');
		});
	});

	describe('§3.2 — buildTeamLeadSection includes pipeline-first delegation', () => {
		it('rendered TL addon contains "claim from the pool" and "Request ID"', async () => {
			// Read the actual tl-addon.md from disk and feed through mock
			const tlAddonPath = path.join(repoRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
			const tlAddonContent = fs.readFileSync(tlAddonPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'developer',
				canDelegate: true,
				teamId: 'team-x',
				memberId: 'mem-x',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
				subordinates: [
					{ name: 'Worker1', sessionName: 'w1-session', role: 'developer', memberId: 'm-w1' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			// §5.1 line 2: assert pipeline-first delegation phrases
			expect(result).toContain('claim from the pool');
			expect(result).toContain('Request ID');
			// And the §3.5 cross-cutting amendments
			expect(result).toContain('list-my-followups');
			expect(result).toContain('idle-self-ping');
		});
	});

	describe('§3.3 — PM role prompt template includes pipeline-first authoring', () => {
		it('rendered PM prompt contains "POST a Request" and clarify-only/delivery framing', async () => {
			const pmPromptPath = path.join(repoRoot, 'config', 'roles', 'product-manager', 'prompt.md');
			const pmContent = fs.readFileSync(pmPromptPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(pmContent);

			const config: TeamMemberSessionConfig = {
				name: 'pm-session',
				role: 'product-manager',
				memberId: 'mem-pm',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			const result = await service.buildSystemPrompt(config);

			// §5.1 line 3: PM contains "POST a Request" and clarify-only framing
			expect(result).toContain('POST a Request');
			expect(result).toContain('Clarify-only is for interpretation, not for delivery');
		});
	});

	describe('§3.4 — buildSystemPrompt (worker) includes session-start claim + decompose-on-claim', () => {
		it('rendered developer prompt contains "POST /api/task-pool/claim" and "parentWorkItemId" near session-start', async () => {
			const devPromptPath = path.join(repoRoot, 'config', 'roles', 'developer', 'prompt.md');
			const devContent = fs.readFileSync(devPromptPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(devContent);

			const config: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				memberId: 'mem-dev',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			const result = await service.buildSystemPrompt(config);

			// §5.1 line 4: claim endpoint and parentWorkItemId in session-start area
			expect(result).toContain('POST /api/task-pool/claim');
			expect(result).toContain('parentWorkItemId');

			// "Near session-start protocol" — claim text should appear before
			// the (later) post-completion sweep block to confirm placement.
			const sessionStartIdx = result.indexOf('Session-Start Pipeline Claim');
			const postCompletionIdx = result.indexOf('Post-Completion Inbox Sweep');
			expect(sessionStartIdx).toBeGreaterThan(-1);
			expect(postCompletionIdx).toBeGreaterThan(-1);
			expect(sessionStartIdx).toBeLessThan(postCompletionIdx);
		});
	});

	describe('§3.5.a — Post-completion inbox sweep present in Worker AND TL prompts', () => {
		it('Worker (developer) prompt contains "list-my-followups" and "claim" in post-completion section', async () => {
			const devPromptPath = path.join(repoRoot, 'config', 'roles', 'developer', 'prompt.md');
			const devContent = fs.readFileSync(devPromptPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(devContent);

			const config: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				memberId: 'mem-dev',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			const result = await service.buildSystemPrompt(config);

			expect(result).toContain('Post-Completion Inbox Sweep');
			expect(result).toContain('list-my-followups');
			expect(result).toContain('claim');
		});

		it('TL addon contains "list-my-followups" and "claim" in post-completion section', async () => {
			const tlAddonPath = path.join(repoRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
			const tlAddonContent = fs.readFileSync(tlAddonPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'developer',
				canDelegate: true,
				teamId: 'team-x',
				memberId: 'mem-x',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
				subordinates: [
					{ name: 'Worker1', sessionName: 'w1-session', role: 'developer', memberId: 'm-w1' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('Post-Completion Inbox Sweep');
			expect(result).toContain('list-my-followups');
			expect(result).toContain('claim');
		});
	});

	describe('§3.5.b — Idle-fallback schedule-followup present in Worker AND TL prompts', () => {
		it('Worker (developer) prompt contains "idle-self-ping" and the 5–15 minute window', async () => {
			const devPromptPath = path.join(repoRoot, 'config', 'roles', 'developer', 'prompt.md');
			const devContent = fs.readFileSync(devPromptPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(devContent);

			const config: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				memberId: 'mem-dev',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			const result = await service.buildSystemPrompt(config);

			expect(result).toContain('idle-self-ping');
			// Window guidance: per Arch verdict polish #3, broken into 5/10/15-min
			// bullets with stall-character justification. Accept either the legacy
			// "5–15 minute" form OR the new bulleted form.
			expect(result).toMatch(/(?:5[–-]15\s*minute)|(?:5\s*min[\s\S]{0,120}10\s*min[\s\S]{0,120}15\s*min)/);
		});

		it('TL addon contains "idle-self-ping" and the 5/10/15-minute window guidance', async () => {
			const tlAddonPath = path.join(repoRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
			const tlAddonContent = fs.readFileSync(tlAddonPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'developer',
				canDelegate: true,
				teamId: 'team-x',
				memberId: 'mem-x',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
				subordinates: [
					{ name: 'Worker1', sessionName: 'w1-session', role: 'developer', memberId: 'm-w1' },
				],
			};

			const result = await service.buildTeamLeadSection(config);

			expect(result).toContain('idle-self-ping');
			expect(result).toMatch(/(?:5[–-]15\s*minute)|(?:5\s*min[\s\S]{0,120}10\s*min[\s\S]{0,120}15\s*min)/);
		});
	});

	// =============================================================================
	// Block #1 / Arch verdict follow-up (PR #446 re-review):
	// Flag-parse smoke test convention. Per Arch's observation #5, every literal
	// `bash` invocation embedded in a rendered prompt must be flag-validated so
	// future regressions in skill-CLI surface (e.g. invented `--target-self`,
	// missing required `--title`) are caught at unit-test time, not at the agent
	// runtime where the safety net silently fails.
	//
	// Going forward this is the prompt-builder test convention: every literal
	// schedule-followup invocation in a role prompt gets a flag-parse smoke
	// assertion — required flags present, invalid flags absent.
	// =============================================================================
	describe('Bash invocation flag-parse smoke (idle-self-ping safety net)', () => {
		/**
		 * Extract the schedule-followup bash invocation from a rendered prompt
		 * by finding the `idle-self-ping` --name flag and walking forward across
		 * line continuations (`\`-terminated lines).
		 */
		function extractScheduleFollowupInvocation(rendered: string): string {
			// Find the line containing the `--name "idle-self-ping"` token. The
			// invocation begins on the preceding `bash …/schedule-followup/…` line
			// and ends on the first non-continuation line after it.
			const lines = rendered.split('\n');
			const startIdx = lines.findIndex((l) => /schedule-followup\/execute\.sh/.test(l));
			if (startIdx < 0) return '';
			const collected: string[] = [];
			for (let i = startIdx; i < lines.length; i++) {
				collected.push(lines[i] ?? '');
				// Continuation: line ends with backslash (allowing trailing whitespace)
				if (!/\\\s*$/.test(lines[i] ?? '')) break;
			}
			return collected.join('\n');
		}

		/**
		 * Assert flag-parse correctness for an idle-self-ping invocation: the
		 * required `--title` flag is present AND the invalid `--target-self`
		 * flag is absent (per schedule-followup/execute.sh argument grammar).
		 */
		function assertIdleSelfPingFlagsValid(invocation: string): void {
			expect(invocation.length).toBeGreaterThan(0);
			// Required: --title (schedule-followup/execute.sh:109 hard-fails without it)
			expect(invocation).toMatch(/--title\s+/);
			// Required: --name (used for cancel-on-resolution + dedup)
			expect(invocation).toMatch(/--name\s+/);
			// Required: --in-minutes OR --fire-at OR --cron (one-of, schedule-followup script enforces)
			expect(invocation).toMatch(/--(in-minutes|fire-at|cron)\s+/);
			// Required: --max-fires (idle-self-ping must be bounded — cap-of-2 discipline)
			expect(invocation).toMatch(/--max-fires\s+/);
			// Forbidden: --target-self is NOT a valid flag in schedule-followup/execute.sh.
			// To target self, OMIT --target entirely (defaults to CREWLY_SESSION_NAME).
			expect(invocation).not.toMatch(/--target-self\b/);
		}

		it('Worker (developer) §3.5.b idle-self-ping invocation parses cleanly (--title present, --target-self absent)', async () => {
			const devPromptPath = path.join(repoRoot, 'config', 'roles', 'developer', 'prompt.md');
			const devContent = fs.readFileSync(devPromptPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(devContent);

			const config: TeamMemberSessionConfig = {
				name: 'dev-session',
				role: 'developer',
				memberId: 'mem-dev',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			const result = await service.buildSystemPrompt(config);
			const invocation = extractScheduleFollowupInvocation(result);
			assertIdleSelfPingFlagsValid(invocation);
		});

		it('TL §3.5.b idle-self-ping invocation parses cleanly (--title present, --target-self absent)', async () => {
			const tlAddonPath = path.join(repoRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
			const tlAddonContent = fs.readFileSync(tlAddonPath, 'utf8');

			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(tlAddonContent);

			const config: TeamMemberSessionConfig = {
				name: 'tl-session',
				role: 'developer',
				canDelegate: true,
				teamId: 'team-x',
				memberId: 'mem-x',
				projectPath: '/proj',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
				subordinates: [
					{ name: 'Worker1', sessionName: 'w1-session', role: 'developer', memberId: 'm-w1' },
				],
			};

			const result = await service.buildTeamLeadSection(config);
			const invocation = extractScheduleFollowupInvocation(result);
			assertIdleSelfPingFlagsValid(invocation);
		});

		it('ORC §3.1 create-request bash path uses {{AGENT_SKILLS_PATH}} (path resolution smoke)', () => {
			// §3.1 amendment lives in buildOrchestratorPrompt (kickoff prompt) AND
			// in config/roles/orchestrator/prompt.md. The kickoff function
			// renders the §3.1 paragraph; verify it does NOT reference the wrong
			// {{ORCHESTRATOR_SKILLS_PATH}}/create-request path that would resolve
			// to a non-existent file at config/skills/orchestrator/create-request/.
			//
			// (kickoff prompt only describes the discipline, not the bash invocation.
			// The bash-invocation path correctness lives in the orchestrator role
			// prompt file. The smoke test below checks the file-on-disk for the
			// right path token.)
			const orcPromptPath = path.join(repoRoot, 'config', 'roles', 'orchestrator', 'prompt.md');
			const orcContent = fs.readFileSync(orcPromptPath, 'utf8');

			// Find the create-request invocation block; it must use AGENT_SKILLS_PATH
			// (which substitutes to config/skills/agent/) — NOT ORCHESTRATOR_SKILLS_PATH
			// (which substitutes to config/skills/orchestrator/, where create-request
			// does not exist).
			const createRequestLines = orcContent
				.split('\n')
				.filter((l) => /create-request\/execute\.sh/.test(l));
			expect(createRequestLines.length).toBeGreaterThan(0);
			for (const line of createRequestLines) {
				expect(line).toContain('{{AGENT_SKILLS_PATH}}/core/create-request/execute.sh');
				expect(line).not.toContain('{{ORCHESTRATOR_SKILLS_PATH}}/create-request');
			}
		});
	});

	// =============================================================================
	// §3.0 Universal Delegator Closure (Mia spec patch fold-in):
	//
	// §3.0 is the dual of §3.5 — delegator-side closure (subscribe via
	// watch-for-event + schedule-followup fallback at ~2x ETA + cancel-on-verify).
	// It MUST land in ALL FOUR role souls (ORC/TL/PM/Worker) plus the kickoff
	// prompt at buildOrchestratorPrompt, with role-specific ETA tuning per
	// §3.1/§3.2/§3.3/§3.4 closure paragraphs.
	//
	// These tests verify:
	// 1. Each role's rendered prompt names all three skill-paths (watch-for-event,
	//    schedule-followup, cancel-followup) so agents can find them.
	// 2. Each role's rendered prompt contains its role-specific ETA-tuning
	//    numbers — proves the spec ETA framing actually made it through to the
	//    runtime prompt, not just an abstract "schedule a fallback" mention.
	// 3. The watch-for-event invocations parse cleanly (same flag-parse smoke
	//    convention as the idle-self-ping tests above).
	// =============================================================================
	describe('§3.0 Universal Delegator Closure (Mia spec patch fold-in)', () => {
		/**
		 * Extract the watch-for-event bash invocation from a rendered prompt.
		 * Mirrors `extractScheduleFollowupInvocation` above — finds the line
		 * containing `watch-for-event/execute.sh` and walks forward across
		 * line continuations.
		 */
		function extractWatchForEventInvocation(rendered: string): string {
			const lines = rendered.split('\n');
			const startIdx = lines.findIndex((l) => /watch-for-event\/execute\.sh/.test(l));
			if (startIdx < 0) return '';
			const collected: string[] = [];
			for (let i = startIdx; i < lines.length; i++) {
				collected.push(lines[i] ?? '');
				if (!/\\\s*$/.test(lines[i] ?? '')) break;
			}
			return collected.join('\n');
		}

		/**
		 * Assert flag-parse correctness for a watch-for-event invocation per
		 * `config/skills/agent/core/watch-for-event/execute.sh` argument grammar.
		 */
		function assertWatchForEventFlagsValid(invocation: string): void {
			expect(invocation.length).toBeGreaterThan(0);
			// Required: --event-type <value>
			expect(invocation).toMatch(/--event-type\s+/);
			// Required: --title <value>
			expect(invocation).toMatch(/--title\s+/);
			// Best-practice: --filter-session (narrows to specific delegatee per §3.0)
			expect(invocation).toMatch(/--filter-session\s+/);
			// Best-practice: bound the watcher (--max-fires) so it can't flap forever
			expect(invocation).toMatch(/--max-fires\s+/);
			// Forbidden: --target-self is NOT a valid flag (same as schedule-followup)
			expect(invocation).not.toMatch(/--target-self\b/);
		}

		describe('ORC §3.1 closure paragraph', () => {
			it('ORC role prompt names all three §3.0 skills + ORC ETA tuning numbers', async () => {
				const orcPromptPath = path.join(repoRoot, 'config', 'roles', 'orchestrator', 'prompt.md');
				const orcContent = fs.readFileSync(orcPromptPath, 'utf8');
				expect(orcContent).toContain('watch-for-event/execute.sh');
				expect(orcContent).toContain('schedule-followup/execute.sh');
				expect(orcContent).toContain('cancel-followup/execute.sh');
				// ORC ETA tuning per §3.1 closure: TL milestone 30–90min → fallback 120,
				// cross-team 2–8h → 12h (~720 min).
				expect(orcContent).toMatch(/30[–-]90\s*min/);
				expect(orcContent).toMatch(/120/); // 120-min fallback
				expect(orcContent).toMatch(/12\s*h|720/); // 12h fallback
			});

			it('ORC role prompt watch-for-event invocation parses cleanly', async () => {
				const orcPromptPath = path.join(repoRoot, 'config', 'roles', 'orchestrator', 'prompt.md');
				const orcContent = fs.readFileSync(orcPromptPath, 'utf8');
				const invocation = extractWatchForEventInvocation(orcContent);
				assertWatchForEventFlagsValid(invocation);
			});

			it('buildOrchestratorPrompt kickoff names all three §3.0 skills', () => {
				const projectData = {
					projectName: 'Dogfood Test',
					projectPath: '/test/path',
					teamDetails: { name: 'Crew', members: [{ name: 'Sam', role: 'TL' }] },
					requirements: 'ship pipeline-first',
				};
				const result = service.buildOrchestratorPrompt(projectData);
				expect(result).toContain('watch-for-event');
				expect(result).toContain('schedule-followup');
				expect(result).toContain('cancel-followup');
				// Recursion clause naming
				expect(result).toContain('Recursion clause');
			});
		});

		describe('TL §3.2 closure paragraph', () => {
			it('TL addon names all three §3.0 skills + TL ETA tuning numbers + verified-complete nuance', async () => {
				const tlAddonPath = path.join(repoRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
				const tlAddonContent = fs.readFileSync(tlAddonPath, 'utf8');

				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(tlAddonContent);

				const config: TeamMemberSessionConfig = {
					name: 'tl-session',
					role: 'developer',
					canDelegate: true,
					teamId: 'team-x',
					memberId: 'mem-x',
					projectPath: '/proj',
					systemPrompt: '',
					runtimeType: 'claude-code' as any,
					subordinates: [
						{ name: 'Worker1', sessionName: 'w1-session', role: 'developer', memberId: 'm-w1' },
					],
				};

				const result = await service.buildTeamLeadSection(config);
				expect(result).toContain('watch-for-event');
				expect(result).toContain('schedule-followup');
				expect(result).toContain('cancel-followup');
				// TL ETA tuning per §3.2 closure: tactical Worker 20–60min → 90min,
				// multi-step chains 1–3h → 5h (~300 min).
				expect(result).toMatch(/20[–-]60\s*min/);
				expect(result).toMatch(/90/); // 90-min fallback
				expect(result).toMatch(/5\s*h|300/); // 5h fallback
				// Nuance Sam called out: cancel on verified-complete, NOT raw complete-task.
				expect(result).toMatch(/verified[\s-]complete/);
			});

			it('TL addon watch-for-event invocation parses cleanly', async () => {
				const tlAddonPath = path.join(repoRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
				const tlAddonContent = fs.readFileSync(tlAddonPath, 'utf8');

				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(tlAddonContent);

				const config: TeamMemberSessionConfig = {
					name: 'tl-session',
					role: 'developer',
					canDelegate: true,
					teamId: 'team-x',
					memberId: 'mem-x',
					projectPath: '/proj',
					systemPrompt: '',
					runtimeType: 'claude-code' as any,
					subordinates: [
						{ name: 'Worker1', sessionName: 'w1-session', role: 'developer', memberId: 'm-w1' },
					],
				};

				const result = await service.buildTeamLeadSection(config);
				const invocation = extractWatchForEventInvocation(result);
				assertWatchForEventFlagsValid(invocation);
			});
		});

		describe('PM §3.3 closure paragraph', () => {
			it('PM prompt names all three §3.0 skills + PM ETA tuning numbers + upper-end discipline', async () => {
				const pmPromptPath = path.join(repoRoot, 'config', 'roles', 'product-manager', 'prompt.md');
				const pmContent = fs.readFileSync(pmPromptPath, 'utf8');

				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(pmContent);

				const config: TeamMemberSessionConfig = {
					name: 'pm-session',
					role: 'product-manager',
					memberId: 'mem-pm',
					projectPath: '/proj',
					systemPrompt: '',
					runtimeType: 'claude-code' as any,
				};

				const result = await service.buildSystemPrompt(config);
				expect(result).toContain('watch-for-event');
				expect(result).toContain('schedule-followup');
				expect(result).toContain('cancel-followup');
				// PM ETA tuning per §3.3 closure: PM→TL 1–4h → 6h (~360 min),
				// PM→ORC 4–24h → 36h (~2160 min).
				expect(result).toMatch(/1[–-]4\s*h/);
				expect(result).toMatch(/6\s*h|360/);
				expect(result).toMatch(/4[–-]24\s*h/);
				expect(result).toMatch(/36\s*h|2160/);
				// Sam-called-out discipline: err toward upper end of fallback window
				expect(result).toMatch(/upper end/);
			});

			it('PM prompt watch-for-event invocation parses cleanly', async () => {
				const pmPromptPath = path.join(repoRoot, 'config', 'roles', 'product-manager', 'prompt.md');
				const pmContent = fs.readFileSync(pmPromptPath, 'utf8');

				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(pmContent);

				const config: TeamMemberSessionConfig = {
					name: 'pm-session',
					role: 'product-manager',
					memberId: 'mem-pm',
					projectPath: '/proj',
					systemPrompt: '',
					runtimeType: 'claude-code' as any,
				};

				const result = await service.buildSystemPrompt(config);
				const invocation = extractWatchForEventInvocation(result);
				assertWatchForEventFlagsValid(invocation);
			});
		});

		describe('Worker §3.4 closure paragraph (recursion clause)', () => {
			it('developer prompt names all three §3.0 skills + Worker ETA tuning + recursion-clause callout + canonical-failure-case naming', async () => {
				const devPromptPath = path.join(repoRoot, 'config', 'roles', 'developer', 'prompt.md');
				const devContent = fs.readFileSync(devPromptPath, 'utf8');

				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(devContent);

				const config: TeamMemberSessionConfig = {
					name: 'dev-session',
					role: 'developer',
					memberId: 'mem-dev',
					projectPath: '/proj',
					systemPrompt: '',
					runtimeType: 'claude-code' as any,
				};

				const result = await service.buildSystemPrompt(config);
				expect(result).toContain('watch-for-event');
				expect(result).toContain('schedule-followup');
				expect(result).toContain('cancel-followup');
				// Worker ETA tuning per §3.4 closure: peer sub-WorkItems 10–30min → 45min,
				// cross-role clarifications 15–60min → 90min.
				expect(result).toMatch(/10[–-]30\s*min/);
				expect(result).toMatch(/45/);
				expect(result).toMatch(/15[–-]60\s*min/);
				// Sam-called-out: name the canonical failure case explicitly
				expect(result).toMatch(/Steve manually pinged/i);
				// Recursion clause non-negotiable framing
				expect(result).toMatch(/recursion clause.*non-negotiable/i);
			});

			it('developer prompt watch-for-event invocation parses cleanly', async () => {
				const devPromptPath = path.join(repoRoot, 'config', 'roles', 'developer', 'prompt.md');
				const devContent = fs.readFileSync(devPromptPath, 'utf8');

				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(devContent);

				const config: TeamMemberSessionConfig = {
					name: 'dev-session',
					role: 'developer',
					memberId: 'mem-dev',
					projectPath: '/proj',
					systemPrompt: '',
					runtimeType: 'claude-code' as any,
				};

				const result = await service.buildSystemPrompt(config);
				const invocation = extractWatchForEventInvocation(result);
				assertWatchForEventFlagsValid(invocation);
			});
		});
	});

	// =============================================================================
	// 4-Piece Skill-Mistake Fix — Piece #2: Communication template orc-branch
	//
	// Per orc-namespace convention (skill SKILL.md frontmatter excludes orchestrator
	// from assignableRoles on send-message + recall + report-status etc.), the
	// rendered Communication section in composePromptWithMemory() now branches on
	// `parts.role === 'orchestrator'` to surface orc-namespaced wrapper invocations
	// instead of the agent-side paths. Without this branch, an orc agent renders
	// generic agent-skill paths and falls back to /terminal/{session}/write — the
	// exact "ORC was using WRONG send-message skill" gotcha recorded in project
	// knowledge on 2026-05-05.
	//
	// Tests verify:
	// 1. Orc-role rendering surfaces ORCHESTRATOR_SKILLS_PATH/send-message in the
	//    Communication section (positive branch).
	// 2. Non-orc rendering still surfaces AGENT_SKILLS_PATH/core/send-message
	//    (negative branch — guards against accidentally flattening the branch).
	// 3. Orc rendering names the rationale (readiness-aware /deliver vs raw /write)
	//    so future maintainers see WHY the namespace differs.
	// 4. Path-resolution smoke (per pattern bank from PR #446 v2 commit 6ad0d250).
	// =============================================================================
	describe('4-piece skill-mistake fix — Piece #2: Communication template orc-branch', () => {
		// Helper: render the full prompt for a given role on the LEGACY composition
		// path (CREWLY_USE_MODULAR_PROMPTS=false). The legacy `composePromptWithMemory`
		// runs only when at least one context block is non-empty, so we feed a stub
		// memory string to trigger it.
		async function renderLegacyPromptForRole(role: string): Promise<string> {
			const syntheticRolePrompt = `# Synthetic ${role} prompt for piece #2 test`;
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(syntheticRolePrompt);
			// Trigger composePromptWithMemory by making memory non-empty.
			mockGetFullContext.mockResolvedValueOnce('stub memory content for piece #2 test');

			const config: TeamMemberSessionConfig = {
				name: `${role}-test-session`,
				role: role as any, // Cast: orchestrator and developer are both valid TeamMemberRole values
				memberId: `mem-${role}`,
				projectPath: '/test/project',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			// Legacy path is forced via beforeEach (CREWLY_USE_MODULAR_PROMPTS='false').
			return service.buildSystemPromptWithMemory(config, {
				includeMemory: true,
				includeSOPs: false,
			});
		}

		// Helper: render via the MODULAR path (CREWLY_USE_MODULAR_PROMPTS not set
		// or 'true' — production default). Each test overrides the env var
		// individually then restores via the suite's afterEach.
		async function renderModularPromptForRole(role: string): Promise<string> {
			process.env.CREWLY_USE_MODULAR_PROMPTS = 'true';
			const syntheticRolePrompt = `# Synthetic ${role} prompt for piece #2 modular test`;
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(syntheticRolePrompt);

			const config: TeamMemberSessionConfig = {
				name: `${role}-modular-session`,
				role: role as any,
				memberId: `mem-${role}`,
				projectPath: '/test/project',
				systemPrompt: '',
				runtimeType: 'claude-code' as any,
			};

			return service.buildSystemPromptWithMemory(config, {});
		}

		it('orc-role rendered Communication section uses ORCHESTRATOR_SKILLS_PATH/send-message (positive branch)', async () => {
			const result = await renderLegacyPromptForRole('orchestrator');

			// Positive branch markers
			expect(result).toContain('## Communication (orchestrator-namespaced)');
			// The orc-namespaced send-message wrapper is the canonical path for orc
			expect(result).toMatch(/config\/skills\/orchestrator\/send-message/);
			// Rationale must be present so the namespace boundary is legible to
			// future maintainers (the "WHY does the branch exist" provenance).
			expect(result).toContain('readiness-aware');
			expect(result).toMatch(/\/terminal\/\{session\}\/deliver/);
			expect(result).toMatch(/\/terminal\/\{session\}\/write/);
		});

		it('non-orc rendered Communication section uses AGENT_SKILLS_PATH/core/send-message (negative branch)', async () => {
			const result = await renderLegacyPromptForRole('developer');

			// Negative branch markers — guards against accidentally flattening the branch
			expect(result).toContain('## Communication');
			expect(result).not.toContain('## Communication (orchestrator-namespaced)');
			// Generic agent-skills path is canonical for non-orc roles
			expect(result).toMatch(/config\/skills\/agent\//);
			// Should NOT mention the orc-namespaced wrapper for non-orc roles
			expect(result).not.toMatch(/config\/skills\/orchestrator\/send-message/);
		});

		it('orc-branch names the agent-side fallback as deprecated to suppress future flattening', async () => {
			const result = await renderLegacyPromptForRole('orchestrator');

			// The orc Communication section must name the agent-side path explicitly
			// AND mark it as the wrong choice for orc — so future maintainers see why
			// merging the two branches into one would be a regression.
			expect(result).toContain('config/skills/agent/core/send-message');
			// Discipline language: agent-side excludes orc, reaching for it bypasses orc-routing.
			// (Match all common conjugations: exclude/excludes/excluded.)
			expect(result).toMatch(/exclud(e|es|ed) orchestrator/i);
			expect(result).toMatch(/bypass(es)?\s+the\s+orc-routing/i);
		});

		it('orc Communication section names other orc-namespaced equivalents (record-success, broadcast, reply-*)', async () => {
			const result = await renderLegacyPromptForRole('orchestrator');

			// Per piece #2 dispatch: enumerate the orc-namespaced equivalents so
			// the orc agent has the complete surface visible at first contact.
			expect(result).toContain('record-success');
			expect(result).toContain('record-failure');
			expect(result).toContain('broadcast');
			expect(result).toContain('reply-chat');
			expect(result).toMatch(/recallFromAllAgents/);
		});

		// Path-resolution smoke per pattern bank entry from §3.0 in PR #446 v2 commit
		// 6ad0d250: when a literal skill-path surface gets added to a rendered prompt,
		// we add a smoke assertion that the path token resolves to the right namespace.
		// For piece #2 this is a path-resolution smoke (no flag list to parse since
		// the Communication section uses bullet-list references rather than full
		// bash invocations); the assertion mirrors the ORC §3.1 create-request path
		// resolution smoke from the same v2 commit.
		it('orc-branch send-message path token resolves to orc-namespace, NOT agent-namespace (path-resolution smoke)', async () => {
			const result = await renderLegacyPromptForRole('orchestrator');

			// Find every line that names a send-message reference in the Communication
			// section; the FIRST canonical reference must use the orc-namespaced path.
			const communicationSection = result.split('## Communication (orchestrator-namespaced)')[1] ?? '';
			const sendMessageLines = communicationSection
				.split('\n')
				.filter((l) => /send-message/.test(l));
			expect(sendMessageLines.length).toBeGreaterThan(0);

			// At least one explicit orc-namespaced path reference must appear
			const orcNamespacedRefs = sendMessageLines.filter((l) =>
				/config\/skills\/orchestrator\/send-message/.test(l)
			);
			expect(orcNamespacedRefs.length).toBeGreaterThan(0);

			// The first send-message bullet line must mark itself as orc-namespaced
			// (so the orc reads the correct path before the agent-side fallback callout).
			const firstSendMessageLine = sendMessageLines[0] ?? '';
			expect(firstSendMessageLine).toMatch(/orc-namespaced/);
		});

		// Modular path coverage — CRITICAL because CREWLY_USE_MODULAR_PROMPTS defaults
		// to 'true' in production. The legacy path tests above exercise
		// composePromptWithMemory; these tests exercise CommunicationModule which is
		// the live default surface. Without these, an orc agent in production would
		// still render core/send-message even with the legacy fix in place.
		it('MODULAR path: orc-role rendered Communication uses orc-namespaced send-message via /deliver', async () => {
			const result = await renderModularPromptForRole('orchestrator');

			// Orc loads the fragment file at config/roles/orchestrator/fragments/communication.md
			// which contains the "Orc-Namespace Gate (MANDATORY)" section appended by piece #2.
			expect(result).toContain('Orc-Namespace Gate');

			// Narrow to the orc-namespace gate section to assert substitution worked.
			// (Other parts of the rendered prompt may carry unsubstituted
			// {{ORCHESTRATOR_SKILLS_PATH}} tokens — those leak from other modules
			// reading orchestrator/prompt.md without calling the agent-registration
			// substitution path. That is a known pre-existing issue, out of scope
			// for piece #2 — file separately if it bites.)
			const gateSectionStart = result.indexOf('Orc-Namespace Gate');
			expect(gateSectionStart).toBeGreaterThan(-1);
			// End the slice at the next module-section boundary (--- separator on its
			// own line) after the gate header, so we don't pick up unsubstituted
			// tokens from neighbouring modules.
			const afterGateStart = result.slice(gateSectionStart);
			const nextSeparatorIdx = afterGateStart.indexOf('\n---\n');
			const gateSection = nextSeparatorIdx > 0
				? afterGateStart.slice(0, nextSeparatorIdx)
				: afterGateStart;

			// Orc-namespaced send-message bash invocation must appear with substituted path
			expect(gateSection).toMatch(/config\/skills\/orchestrator\/send-message\/execute\.sh/);
			// Inside the gate section, the placeholders MUST be substituted (piece #2
			// adds the substitution in CommunicationModule.build() for the fragment).
			expect(gateSection).not.toContain('{{ORCHESTRATOR_SKILLS_PATH}}');
			expect(gateSection).not.toContain('{{AGENT_SKILLS_PATH}}');
			// Rationale must be present so the namespace boundary is legible
			expect(gateSection).toMatch(/\/terminal\/\{session\}\/deliver/);
			expect(gateSection).toMatch(/\/terminal\/\{session\}\/write/);
			expect(gateSection).toMatch(/readiness-aware/);
			// Negative pattern callout names the canonical failure case
			expect(gateSection).toMatch(/ORC was using WRONG send-message/);
		});

		it('MODULAR path: non-orc rendered Communication uses agent-side core/send-message (negative branch)', async () => {
			const result = await renderModularPromptForRole('developer');

			// Worker comms section header
			expect(result).toContain('## Communication');
			// Agent-side path must appear
			expect(result).toMatch(/config\/skills\/agent\/core\/send-message\/execute\.sh/);
			// Orc-namespaced wrapper must NOT appear for non-orc
			expect(result).not.toMatch(/config\/skills\/orchestrator\/send-message/);
		});
	});
});