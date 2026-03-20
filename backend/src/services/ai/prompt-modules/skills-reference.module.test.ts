import { SkillsReferenceModule } from './skills-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('SkillsReferenceModule', () => {
	let module: SkillsReferenceModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-dev-001',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new SkillsReferenceModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('skills_references');
		expect(module.priority).toBe(5);
		expect(module.maxTokens).toBe(500);
		expect(module.compactable).toBe(true);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
	});

	it('should include skill paths in output', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('/path/to/skills/agent/');
	});

	it('should reference core skills for all roles', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('core/recall');
		expect(result).toContain('core/remember');
		expect(result).toContain('core/record-learning');
		expect(result).toContain('core/report-status');
	});

	it('should include skill catalog reference', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('AGENT_SKILLS_CATALOG.md');
	});

	it('should include capabilities section', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Available Capabilities');
		expect(result).toContain('Playwright MCP server');
	});

	it('should include memory tool instructions', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('agentId');
		expect(result).toContain('projectPath');
		expect(result).toContain('IMPORTANT for memory tools');
	});

	describe('role-based capabilities (#225)', () => {
		it('should give workers narrow scope (no TL skills path)', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('Read/Write');
			expect(result).toContain('agent core skills');
			expect(result).not.toContain('team leader skills');
			expect(result).not.toContain('orchestrator skill');
			expect(result).not.toContain('delegate-task');
		});

		it('should give orchestrators coordination scope', async () => {
			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('orchestrator skill scripts');
			expect(result).toContain('schedule-check');
			expect(result).toContain('subscribe-event');
			expect(result).toContain('reply-slack');
			expect(result).toContain('delegate-task');
			expect(result).toContain('delegated to agents');
		});

		it('should give TLs delegation scope', async () => {
			const tlConfig: ModuleConfig = { ...baseConfig, role: 'team-leader', canDelegate: true };
			const result = await module.build(tlConfig);

			expect(result).toContain('team leader skills');
			expect(result).toContain('delegate-task');
			expect(result).toContain('verify-output');
			expect(result).toContain('schedule-check');
			expect(result).toContain(baseConfig.tlSkillsPath);
		});

		it('should not include blanket authorization language', async () => {
			for (const role of ['developer', 'orchestrator']) {
				const config: ModuleConfig = { ...baseConfig, role };
				const result = await module.build(config);

				expect(result).not.toContain('pre-approved');
				expect(result).not.toContain('Authorized Operations');
				expect(result).not.toContain('authorized to');
				expect(result).not.toContain('adopt');
			}
		});

		it('should distinguish read vs write for orchestrator', async () => {
			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('**Read** project files');
			expect(result).not.toContain('Read/Write');
		});
	});
});
