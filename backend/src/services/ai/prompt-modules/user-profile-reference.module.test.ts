import { UserProfileReferenceModule } from './user-profile-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('UserProfileReferenceModule', () => {
	let module: UserProfileReferenceModule;

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
		module = new UserProfileReferenceModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('user_profile_reference');
		expect(module.priority).toBe(9);
		expect(module.maxTokens).toBe(200);
		expect(module.compactable).toBe(true);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, projectPath: undefined })).toBe(true);
	});

	it('should build user profile reference with language matching', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('## User Preferences');
		expect(result).toContain('### Language Matching');
		expect(result).toContain('Chinese');
		expect(result).toContain('English');
	});

	it('should include recall command with correct agentId', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('recall/execute.sh');
		expect(result).toContain(baseConfig.sessionName);
		expect(result).toContain('user preferences');
	});

	it('should include remember command for storing preferences', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('remember/execute.sh');
		expect(result).toContain('"category":"preference"');
		expect(result).toContain('"scope":"agent"');
	});

	it('should include adaptation rules', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('### Adaptation Rules');
		expect(result).toContain('verbosity');
		expect(result).toContain('formality');
	});

	it('should use correct skill paths from config', async () => {
		const customConfig = { ...baseConfig, agentSkillsPath: '/custom/skills/path' };
		const result = await module.build(customConfig);

		expect(result).toContain('/custom/skills/path/core/recall');
		expect(result).toContain('/custom/skills/path/core/remember');
	});

	it('should handle missing projectPath gracefully', async () => {
		const configNoProject = { ...baseConfig, projectPath: undefined };
		const result = await module.build(configNoProject);

		expect(result).toContain('## User Preferences');
		expect(result).toContain('"projectPath":""');
	});
});
