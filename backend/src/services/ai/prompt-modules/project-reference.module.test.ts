import { ProjectReferenceModule } from './project-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('ProjectReferenceModule', () => {
	let module: ProjectReferenceModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-dev-001',
		memberId: 'member-001',
		role: 'developer',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new ProjectReferenceModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('project_references');
		expect(module.priority).toBe(7);
		expect(module.maxTokens).toBe(400);
		expect(module.compactable).toBe(true);
	});

	it('should include when project path is set', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
	});

	it('should not include when project path is missing', () => {
		const config = { ...baseConfig, projectPath: undefined };
		expect(module.shouldInclude(config)).toBe(false);
	});

	it('should include project standards', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('## Project References');
		expect(result).toContain('TypeScript strict mode');
		expect(result).toContain('80%+ test coverage');
		expect(result).toContain('secure coding practices');
	});

	it('should include SOP instructions with skill path', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('get-sops');
		expect(result).toContain('/path/to/skills/agent');
		expect(result).toContain('developer');
	});

	it('should include project knowledge paths', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('/Users/user/projects/crewly/.crewly/specs/');
		expect(result).toContain('/Users/user/projects/crewly/.crewly/goals/goals.md');
		expect(result).toContain('/Users/user/projects/crewly/.crewly/tasks/');
		expect(result).toContain('/Users/user/projects/crewly/.crewly/knowledge/');
	});
});
