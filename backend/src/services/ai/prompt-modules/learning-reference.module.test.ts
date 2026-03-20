import { LearningReferenceModule } from './learning-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('LearningReferenceModule', () => {
	let module: LearningReferenceModule;

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
		module = new LearningReferenceModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('learning_references');
		expect(module.priority).toBe(10);
		expect(module.maxTokens).toBe(250);
		expect(module.compactable).toBe(true);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, projectPath: undefined })).toBe(true);
	});

	it('should build learning reference with record-learning command', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('## Learning from Experience');
		expect(result).toContain('record-learning/execute.sh');
		expect(result).toContain(baseConfig.sessionName);
		expect(result).toContain(baseConfig.role);
	});

	it('should include when-to-record guidelines', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('**When to record:**');
		expect(result).toContain('resolving a bug');
		expect(result).toContain('failed approach');
		expect(result).toContain('completing a task');
	});

	it('should include recall command for checking learnings', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('### Recalling Learnings');
		expect(result).toContain('recall/execute.sh');
		expect(result).toContain('learnings about');
	});

	it('should include applying learnings section', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('### Applying Learnings');
		expect(result).toContain('Cross-reference');
		expect(result).toContain('stale learnings');
	});

	it('should use correct skill paths from config', async () => {
		const customConfig = { ...baseConfig, agentSkillsPath: '/custom/skills' };
		const result = await module.build(customConfig);

		expect(result).toContain('/custom/skills/core/record-learning');
		expect(result).toContain('/custom/skills/core/recall');
	});

	it('should handle missing projectPath gracefully', async () => {
		const configNoProject = { ...baseConfig, projectPath: undefined };
		const result = await module.build(configNoProject);

		expect(result).toContain('## Learning from Experience');
		expect(result).toContain('"projectPath":""');
	});
});
