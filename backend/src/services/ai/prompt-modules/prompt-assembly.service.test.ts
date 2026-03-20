import { PromptAssemblyService } from './prompt-assembly.service.js';
import { PromptModule, ModuleConfig, estimateTokens } from './prompt-module.interface.js';

// Mock logger
jest.mock('../../core/logger.service.js', () => ({
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

// Mock fs/promises for TeamReferenceModule
jest.mock('fs/promises', () => ({
	readFile: jest.fn().mockRejectedValue(new Error('ENOENT')),
	access: jest.fn().mockRejectedValue(new Error('ENOENT')),
}));

// Mock fs for TeamReferenceModule
jest.mock('fs', () => ({
	existsSync: jest.fn().mockReturnValue(false),
	readdirSync: jest.fn().mockReturnValue([]),
	readFileSync: jest.fn().mockReturnValue(''),
}));

describe('PromptAssemblyService', () => {
	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-dev-001',
		memberId: 'member-001',
		role: 'developer',
		teamId: 'team-001',
		projectPath: '/project',
		agentSkillsPath: '/skills/agent',
		tlSkillsPath: '/skills/team-leader',
		projectRoot: '/project-root',
	};

	describe('constructor', () => {
		it('should register default modules', () => {
			const service = new PromptAssemblyService();
			const modules = service.getModules();

			expect(modules.length).toBeGreaterThanOrEqual(5);
			const names = modules.map((m) => m.name);
			expect(names).toContain('identity');
			expect(names).toContain('skills_references');
			expect(names).toContain('memory_references');
			expect(names).toContain('team_references');
			expect(names).toContain('project_references');
		});

		it('should use default token budget of 25000', () => {
			const service = new PromptAssemblyService();
			expect(service.tokenBudget()).toBe(25000);
		});

		it('should accept custom token budget', () => {
			const service = new PromptAssemblyService(10000);
			expect(service.tokenBudget()).toBe(10000);
		});
	});

	describe('addModule / removeModule', () => {
		it('should add a custom module', () => {
			const service = new PromptAssemblyService();
			const customModule: PromptModule = {
				name: 'custom',
				priority: 99,
				maxTokens: 100,
				compactable: true,
				shouldInclude: () => true,
				build: async () => 'custom content',
			};

			service.addModule(customModule);
			expect(service.getModules().map((m) => m.name)).toContain('custom');
		});

		it('should remove a module by name', () => {
			const service = new PromptAssemblyService();
			service.removeModule('identity');
			expect(service.getModules().map((m) => m.name)).not.toContain('identity');
		});
	});

	describe('assemble', () => {
		it('should assemble all default modules', async () => {
			const service = new PromptAssemblyService();
			const prompt = await service.assemble(baseConfig);

			// Should contain identity section
			expect(prompt).toContain('## Your Identity');
			expect(prompt).toContain('crewly-dev-001');

			// Should contain memory routing
			expect(prompt).toContain('Memory Routing Rules');

			// Should contain skills reference
			expect(prompt).toContain('Available Skills');

			// Should contain project references
			expect(prompt).toContain('Project References');
		});

		it('should assemble modules in priority order', async () => {
			const service = new PromptAssemblyService();
			// Remove defaults and add controlled modules
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			const order: string[] = [];

			service.addModule({
				name: 'low-priority',
				priority: 10,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => { order.push('low-priority'); return 'low'; },
			});

			service.addModule({
				name: 'high-priority',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => { order.push('high-priority'); return 'high'; },
			});

			service.addModule({
				name: 'mid-priority',
				priority: 5,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => { order.push('mid-priority'); return 'mid'; },
			});

			await service.assemble(baseConfig);

			expect(order).toEqual(['high-priority', 'mid-priority', 'low-priority']);
		});

		it('should skip modules where shouldInclude returns false', async () => {
			const service = new PromptAssemblyService();
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'included',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'included-content',
			});

			service.addModule({
				name: 'excluded',
				priority: 2,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => false,
				build: async () => 'excluded-content',
			});

			const prompt = await service.assemble(baseConfig);

			expect(prompt).toContain('included-content');
			expect(prompt).not.toContain('excluded-content');
		});

		it('should skip compactable modules when token budget exceeded', async () => {
			const service = new PromptAssemblyService(50); // Very small budget
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'essential',
				priority: 1,
				maxTokens: 30,
				compactable: false, // Non-compactable: always included
				shouldInclude: () => true,
				build: async () => 'a'.repeat(100), // ~25 tokens
			});

			service.addModule({
				name: 'optional',
				priority: 2,
				maxTokens: 100,
				compactable: true, // Compactable: skipped when over budget
				shouldInclude: () => true,
				build: async () => 'optional-content',
			});

			const prompt = await service.assemble(baseConfig);

			expect(prompt).toContain('a'.repeat(100));
			expect(prompt).not.toContain('optional-content');
		});

		it('should always include non-compactable modules regardless of budget', async () => {
			const service = new PromptAssemblyService(1); // Tiny budget
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'critical',
				priority: 1,
				maxTokens: 1000,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'critical-content',
			});

			const prompt = await service.assemble(baseConfig);
			expect(prompt).toContain('critical-content');
		});

		it('should separate modules with ---', async () => {
			const service = new PromptAssemblyService();
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'first',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'first-content',
			});

			service.addModule({
				name: 'second',
				priority: 2,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'second-content',
			});

			const prompt = await service.assemble(baseConfig);

			expect(prompt).toBe('first-content\n\n---\n\nsecond-content');
		});

		it('should skip modules that return empty content', async () => {
			const service = new PromptAssemblyService();
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'non-empty',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'content',
			});

			service.addModule({
				name: 'empty',
				priority: 2,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => '',
			});

			const prompt = await service.assemble(baseConfig);
			expect(prompt).toBe('content');
		});

		it('should handle module build errors for compactable modules gracefully', async () => {
			const service = new PromptAssemblyService();
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'ok',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'ok-content',
			});

			service.addModule({
				name: 'broken',
				priority: 2,
				maxTokens: 100,
				compactable: true,
				shouldInclude: () => true,
				build: async () => { throw new Error('build failed'); },
			});

			const prompt = await service.assemble(baseConfig);
			expect(prompt).toBe('ok-content');
		});

		it('should throw when non-compactable module fails', async () => {
			const service = new PromptAssemblyService();
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'critical-broken',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => { throw new Error('critical failure'); },
			});

			await expect(service.assemble(baseConfig)).rejects.toThrow('critical failure');
		});
	});

	describe('assembleWithDetails', () => {
		it('should return module details with token estimates', async () => {
			const service = new PromptAssemblyService();
			for (const m of service.getModules()) {
				service.removeModule(m.name);
			}

			service.addModule({
				name: 'test-module',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'test content here',
			});

			const result = await service.assembleWithDetails(baseConfig);

			expect(result.modules.length).toBe(1);
			expect(result.modules[0].name).toBe('test-module');
			expect(result.modules[0].content).toBe('test content here');
			expect(result.modules[0].estimatedTokens).toBe(estimateTokens('test content here'));
			expect(result.totalTokens).toBe(estimateTokens('test content here'));
			expect(result.prompt).toBe('test content here');
		});
	});

	describe('tokenBudget', () => {
		it('should get the current budget', () => {
			const service = new PromptAssemblyService(5000);
			expect(service.tokenBudget()).toBe(5000);
		});

		it('should set a new budget', () => {
			const service = new PromptAssemblyService();
			service.tokenBudget(10000);
			expect(service.tokenBudget()).toBe(10000);
		});
	});
});
