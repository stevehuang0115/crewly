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
		expect(result).toContain('/path/to/skills/team-leader/');
	});

	it('should reference core skills', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('core/recall');
		expect(result).toContain('core/remember');
		expect(result).toContain('core/record-learning');
		expect(result).toContain('core/report-status');
		expect(result).toContain('core/send-message');
		expect(result).toContain('core/get-sops');
	});

	it('should include skill catalog reference', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('AGENT_SKILLS_CATALOG.md');
	});

	it('should include authorization section', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Authorized Operations');
		expect(result).toContain('pre-approved');
	});

	it('should include memory tool instructions', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('agentId');
		expect(result).toContain('projectPath');
		expect(result).toContain('IMPORTANT for memory tools');
	});
});
