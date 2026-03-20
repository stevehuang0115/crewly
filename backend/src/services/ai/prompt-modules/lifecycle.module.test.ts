import { LifecycleModule } from './lifecycle.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

// Mock fs for fragment loading
jest.mock('fs', () => ({
	existsSync: jest.fn().mockReturnValue(false),
	readFileSync: jest.fn().mockReturnValue(''),
}));

describe('LifecycleModule', () => {
	let module: LifecycleModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-sam-217bfbbf',
		memberId: '217bfbbf-9c90-41ec-bf93-b7fca1b5934f',
		role: 'developer',
		teamId: '817a1aeb-b04e-45dd-bdbc-be5cbc4345f1',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new LifecycleModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('lifecycle');
		expect(module.priority).toBe(11);
		expect(module.maxTokens).toBe(800);
		expect(module.compactable).toBe(true);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, role: 'orchestrator' })).toBe(true);
	});

	describe('worker lifecycle (default)', () => {
		it('should build compact work rhythm', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('## Work Rhythm');
			expect(result).toContain('### On Session Start');
			expect(result).toContain('### During Work');
			expect(result).toContain('### Before Context Runs Low');
		});

		it('should include record-learning command', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('record-learning');
			expect(result).toContain(baseConfig.sessionName);
			expect(result).toContain(baseConfig.role);
		});

		it('should reference recovery protocol in startup', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('recall + get-my-context');
		});

		it('should not include orchestrator-specific content', async () => {
			const result = await module.build(baseConfig);

			expect(result).not.toContain('Cognitive Lifecycle');
			expect(result).not.toContain('Proactive Monitoring');
			expect(result).not.toContain('schedule-check');
		});
	});

	describe('orchestrator lifecycle', () => {
		const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };

		it('should build full lifecycle management', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('## Lifecycle Management');
			expect(result).toContain('### Cognitive Lifecycle (4 Stages)');
			expect(result).toContain('### Proactive Monitoring');
			expect(result).toContain('### Auto Progress Heartbeat');
			expect(result).toContain('### Session Management');
			expect(result).toContain('### Daily Workflow');
		});

		it('should include 4-stage cognitive loop', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('**Intent**');
			expect(result).toContain('**Observation**');
			expect(result).toContain('**Strategy**');
			expect(result).toContain('**Adaptation**');
		});

		it('should include proactive monitoring rules', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('schedule-check');
			expect(result).toContain('idle/error states');
			expect(result).toContain('15 minutes');
		});

		it('should include heartbeat command', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('report-status');
			expect(result).toContain(orchConfig.sessionName);
			expect(result).toContain(orchConfig.agentSkillsPath);
		});
	});

	describe('team leader lifecycle', () => {
		const tlConfig: ModuleConfig = { ...baseConfig, role: 'team-leader', canDelegate: true };

		it('should build full lifecycle (same as orchestrator)', async () => {
			const result = await module.build(tlConfig);

			expect(result).toContain('## Lifecycle Management');
			expect(result).toContain('Cognitive Lifecycle');
			expect(result).toContain('Proactive Monitoring');
		});

		it('should include session management', async () => {
			const result = await module.build(tlConfig);

			expect(result).toContain('### Session Management');
			expect(result).toContain('record-learning');
		});
	});

	describe('projectPath fallback', () => {
		it('should use projectRoot when projectPath is undefined for worker', async () => {
			const noPathConfig: ModuleConfig = {
				...baseConfig,
				projectPath: undefined,
			};
			const result = await module.build(noPathConfig);

			expect(result).toContain(baseConfig.projectRoot);
			expect(result).not.toContain('undefined');
		});

		it('should use projectRoot when projectPath is undefined for orchestrator', async () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValue(false);

			const noPathConfig: ModuleConfig = {
				...baseConfig,
				role: 'orchestrator',
				projectPath: undefined,
			};
			const result = await module.build(noPathConfig);

			expect(result).toContain(baseConfig.projectRoot);
		});
	});

	describe('fragment loading', () => {
		it('should load fragment for orchestrator when available', async () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValueOnce(true);
			fs.readFileSync.mockReturnValueOnce('# Orchestrator Lifecycle\nMonitoring protocol here');

			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('Orchestrator Lifecycle');
			expect(result).toContain('Monitoring protocol here');
		});

		it('should fall back to inline content when no fragment', async () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValue(false);

			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('## Lifecycle Management');
		});

		it('should not attempt fragment loading for TL', async () => {
			const tlConfig: ModuleConfig = { ...baseConfig, role: 'team-leader', canDelegate: true };
			const result = await module.build(tlConfig);

			expect(result).toContain('## Lifecycle Management');
		});
	});
});
