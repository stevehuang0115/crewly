import { IdentityModule } from './identity.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('IdentityModule', () => {
	let module: IdentityModule;

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
		module = new IdentityModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('identity');
		expect(module.priority).toBe(1);
		expect(module.maxTokens).toBe(150);
		expect(module.compactable).toBe(false);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, teamId: undefined })).toBe(true);
	});

	it('should build identity with all fields', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('## Your Identity');
		expect(result).toContain('**Session Name:** crewly-product-sam-217bfbbf');
		expect(result).toContain('**Member ID:** 217bfbbf-9c90-41ec-bf93-b7fca1b5934f');
		expect(result).toContain('**Role:** developer');
		expect(result).toContain('**Team:** 817a1aeb-b04e-45dd-bdbc-be5cbc4345f1');
		expect(result).toContain('**Project Path:** /Users/user/projects/crewly');
	});

	it('should omit missing optional fields', async () => {
		const minConfig: ModuleConfig = {
			sessionName: 'test-session',
			memberId: 'member-001',
			role: 'developer',
			agentSkillsPath: '/skills',
			tlSkillsPath: '/tl-skills',
			projectRoot: '/project',
		};

		const result = await module.build(minConfig);

		expect(result).toContain('**Session Name:** test-session');
		expect(result).toContain('**Role:** developer');
		expect(result).not.toContain('**Team:**');
		expect(result).not.toContain('**Project Path:**');
	});

	it('should produce output matching existing identity format', async () => {
		const result = await module.build(baseConfig);
		const lines = result.split('\n');

		// First line is the heading
		expect(lines[0]).toBe('## Your Identity');
		// All subsequent lines are bullet points
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i]).toMatch(/^- \*\*/);
		}
	});
});
