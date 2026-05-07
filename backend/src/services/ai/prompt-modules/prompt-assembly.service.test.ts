// ExpertProfileModule integration
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

// Mock fs for TeamReferenceModule and SoulModule
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

	/**
	 * Helper: create a service with only custom modules (clears defaults).
	 */
	function emptyService(budget?: number): PromptAssemblyService {
		const service = new PromptAssemblyService(budget);
		for (const m of service.getModules()) {
			service.removeModule(m.name);
		}
		return service;
	}

	describe('constructor', () => {
		it('should register default modules including Phase 1-4', () => {
			const service = new PromptAssemblyService();
			const names = service.getModules().map((m) => m.name);

			expect(names).toContain('identity');
			expect(names).toContain('soul');
			expect(names).toContain('skills_references');
			expect(names).toContain('memory_references');
			expect(names).toContain('team_references');
			expect(names).toContain('project_references');
			expect(names).toContain('communication');
			expect(names).toContain('recovery');
			expect(names).toContain('lifecycle');
			expect(names).toContain('user_profile_reference');
			expect(names).toContain('learning_references');
			// Architecture Upgrade modules
			expect(names).toContain('role-boundary');
			expect(names).toContain('capability-overlay');
			expect(names).toContain('domain-sop');
			expect(names).toContain('risk-policy');
			expect(names).toContain('team-norms');
			// Mission/OKR card (fix #415 — replaces dead PromptGenerator hook)
			expect(names).toContain('mission_context');
			// Decision Rights + Escalation Chain (P0-4 — authority text, priority 3.5)
			expect(names).toContain('decision-rights');
			// Request Contract (P0-3 — authority text, priority 3.6)
			expect(names).toContain('request-contract');
			// Lazy Behavior Anti-Patterns (P1 Fix 8 — authority text, priority 3.7)
			expect(names).toContain('lazy-anti-patterns');
			// Default Execution Loop (P1 Fix 6 — behavioral mandate, priority 3.8)
			expect(names).toContain('default-execution-loop');
			expect(names.length).toBe(23);
		});

		it('should use default token budget of 28000', () => {
			const service = new PromptAssemblyService();
			expect(service.tokenBudget()).toBe(28000);
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
		it('should assemble all default modules and return report', async () => {
			const service = new PromptAssemblyService();
			const { prompt, report } = await service.assemble(baseConfig);

			expect(prompt).toContain('## Your Identity');
			expect(prompt).toContain('crewly-dev-001');
			expect(report.totalTokens).toBeGreaterThan(0);
			expect(report.moduleBreakdown.length).toBeGreaterThan(0);
			expect(Array.isArray(report.truncated)).toBe(true);
		});

		it('should assemble modules in priority order', async () => {
			const service = emptyService();
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
			const service = emptyService();

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

			const { prompt } = await service.assemble(baseConfig);
			expect(prompt).toContain('included-content');
			expect(prompt).not.toContain('excluded-content');
		});

		it('should separate modules with ---', async () => {
			const service = emptyService();

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

			const { prompt } = await service.assemble(baseConfig);
			expect(prompt).toBe('first-content\n\n---\n\nsecond-content');
		});

		it('should skip modules that return empty content', async () => {
			const service = emptyService();

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

			const { prompt } = await service.assemble(baseConfig);
			expect(prompt).toBe('content');
		});

		it('should handle module build errors for compactable modules gracefully', async () => {
			const service = emptyService();

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

			const { prompt } = await service.assemble(baseConfig);
			expect(prompt).toBe('ok-content');
		});

		it('should throw when non-compactable module fails', async () => {
			const service = emptyService();

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

	describe('token budget enforcement', () => {
		it('should always include non-compactable modules regardless of budget', async () => {
			const service = emptyService(1); // Tiny budget

			service.addModule({
				name: 'critical',
				priority: 1,
				maxTokens: 1000,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'critical-content',
			});

			const { prompt, report } = await service.assemble(baseConfig);
			expect(prompt).toContain('critical-content');
			expect(report.truncated.length).toBe(0);
		});

		it('should trim compactable modules to 50% when over budget (stage 1)', async () => {
			// Build multi-line content: 20 lines × ~20 chars = ~400 chars = ~100 tokens
			const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of content`);
			const longContent = lines.join('\n');
			const fullTokens = estimateTokens(longContent); // ~100

			// Trusted ~2 tokens. Budget = trusted + 60% of compactable
			// This means trimming to 50% will bring it under budget, no removal needed
			const budget = 2 + Math.floor(fullTokens * 0.6);
			const service = emptyService(budget);

			service.addModule({
				name: 'trusted',
				priority: 1,
				maxTokens: 50,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'short', // ~2 tokens
			});

			service.addModule({
				name: 'flexible',
				priority: 10,
				maxTokens: 200,
				compactable: true,
				shouldInclude: () => true,
				build: async () => longContent,
			});

			const { prompt, report } = await service.assemble(baseConfig);

			expect(prompt).toContain('short');
			expect(report.truncated.length).toBe(1);
			expect(report.truncated[0].name).toBe('flexible');
			expect(report.truncated[0].action).toBe('trimmed');
			expect(report.truncated[0].finalTokens).toBeLessThan(report.truncated[0].originalTokens);
		});

		it('should remove compactable modules entirely when trim is not enough (stage 2)', async () => {
			const service = emptyService(5); // Very tiny budget

			service.addModule({
				name: 'trusted',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'ok', // ~1 token
			});

			const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of bloated content`);

			service.addModule({
				name: 'removable',
				priority: 10,
				maxTokens: 500,
				compactable: true,
				shouldInclude: () => true,
				build: async () => lines.join('\n'), // ~250 tokens
			});

			const { prompt, report } = await service.assemble(baseConfig);

			expect(prompt).toContain('ok');
			expect(prompt).not.toContain('bloated');
			expect(report.truncated.length).toBe(1);
			expect(report.truncated[0].name).toBe('removable');
			expect(report.truncated[0].action).toBe('removed');
			expect(report.truncated[0].finalTokens).toBe(0);
		});

		it('should trim lowest-priority modules first', async () => {
			// Budget allows trusted + one compactable but not two
			const service = emptyService(40);

			service.addModule({
				name: 'trusted',
				priority: 1,
				maxTokens: 50,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'hi', // ~1 token
			});

			service.addModule({
				name: 'high-flex',
				priority: 3,
				maxTokens: 200,
				compactable: true,
				shouldInclude: () => true,
				build: async () => 'a'.repeat(80), // ~20 tokens
			});

			service.addModule({
				name: 'low-flex',
				priority: 9,
				maxTokens: 200,
				compactable: true,
				shouldInclude: () => true,
				build: async () => 'b'.repeat(80), // ~20 tokens
			});

			const { report } = await service.assemble(baseConfig);

			// low-flex (priority 9) should be truncated/removed before high-flex (priority 3)
			const truncatedNames = report.truncated.map((t) => t.name);
			if (truncatedNames.length > 0) {
				expect(truncatedNames[0]).toBe('low-flex');
			}
		});

		it('should not truncate when within budget', async () => {
			const service = emptyService(50000);

			service.addModule({
				name: 'mod1',
				priority: 1,
				maxTokens: 100,
				compactable: true,
				shouldInclude: () => true,
				build: async () => 'content',
			});

			const { report } = await service.assemble(baseConfig);
			expect(report.truncated.length).toBe(0);
			expect(report.totalTokens).toBeGreaterThan(0);
		});

		it('should report per-module breakdown', async () => {
			const service = emptyService();

			service.addModule({
				name: 'mod-a',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'content-a',
			});

			service.addModule({
				name: 'mod-b',
				priority: 2,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'content-b',
			});

			const { report } = await service.assemble(baseConfig);
			expect(report.moduleBreakdown.length).toBe(2);
			expect(report.moduleBreakdown[0].name).toBe('mod-a');
			expect(report.moduleBreakdown[1].name).toBe('mod-b');
			expect(report.totalTokens).toBe(
				report.moduleBreakdown.reduce((sum, m) => sum + m.estimatedTokens, 0)
			);
		});
	});

	describe('assembleWithDetails', () => {
		it('should return module details with token estimates and truncated info', async () => {
			const service = emptyService();

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
			expect(Array.isArray(result.truncated)).toBe(true);
		});
	});

	describe('evalMode', () => {
		it('should only include core modules when evalMode is true', async () => {
			const service = new PromptAssemblyService();
			const evalConfig: ModuleConfig = { ...baseConfig, evalMode: true };
			const { report } = await service.assemble(evalConfig);

			// Core modules: identity, soul, role-boundary, recovery, decision-rights, lazy-anti-patterns
			const moduleNames = report.moduleBreakdown.map((m) => m.name);
			const allowedCoreNames = new Set([
				'identity',
				'soul',
				'role-boundary',
				'recovery',
				'decision-rights',
				'lazy-anti-patterns',
			]);
			for (const name of moduleNames) {
				expect(allowedCoreNames.has(name)).toBe(true);
			}
		});

		it('should include decision-rights authority text in evalMode', async () => {
			const service = new PromptAssemblyService();
			const evalConfig: ModuleConfig = { ...baseConfig, evalMode: true };
			const { prompt, report } = await service.assemble(evalConfig);
			const moduleNames = report.moduleBreakdown.map((m) => m.name);
			expect(moduleNames).toContain('decision-rights');
			expect(prompt).toContain('## Decision Rights');
			expect(prompt).toContain('## Escalation Chain');
		});

		it('should include lazy-anti-patterns authority text in evalMode', async () => {
			const service = new PromptAssemblyService();
			const evalConfig: ModuleConfig = { ...baseConfig, evalMode: true };
			const { prompt, report } = await service.assemble(evalConfig);
			const moduleNames = report.moduleBreakdown.map((m) => m.name);
			expect(moduleNames).toContain('lazy-anti-patterns');
			expect(prompt).toContain('## Lazy Behavior Anti-Patterns');
			expect(prompt).toContain('You are failing the task if you:');
		});

		it('should include all modules when evalMode is false', async () => {
			const service = new PromptAssemblyService();
			const normalConfig: ModuleConfig = { ...baseConfig, evalMode: false };
			const { report } = await service.assemble(normalConfig);

			const moduleNames = report.moduleBreakdown.map((m) => m.name);
			// Should have more than just core modules
			expect(moduleNames.length).toBeGreaterThan(4);
		});

		it('should include all modules when evalMode is undefined', async () => {
			const service = new PromptAssemblyService();
			const { report } = await service.assemble(baseConfig);

			const moduleNames = report.moduleBreakdown.map((m) => m.name);
			expect(moduleNames.length).toBeGreaterThan(4);
		});

		it('should skip non-core custom modules in evalMode', async () => {
			const service = emptyService();

			service.addModule({
				name: 'identity',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: () => true,
				build: async () => 'identity-content',
			});

			service.addModule({
				name: 'custom-extra',
				priority: 10,
				maxTokens: 100,
				compactable: true,
				shouldInclude: () => true,
				build: async () => 'extra-content',
			});

			const evalConfig: ModuleConfig = { ...baseConfig, evalMode: true };
			const { prompt } = await service.assemble(evalConfig);

			expect(prompt).toContain('identity-content');
			expect(prompt).not.toContain('extra-content');
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
