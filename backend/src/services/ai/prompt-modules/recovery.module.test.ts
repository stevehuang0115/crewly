import { RecoveryModule } from './recovery.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('RecoveryModule', () => {
	let module: RecoveryModule;

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
		module = new RecoveryModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('recovery');
		expect(module.priority).toBe(2);
		expect(module.maxTokens).toBe(600);
		expect(module.compactable).toBe(false);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, role: 'orchestrator' })).toBe(true);
	});

	it('should build recovery protocol with all three steps', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('## Session Recovery Protocol (MANDATORY)');
		expect(result).toContain('### Step 1: Recall previous knowledge');
		expect(result).toContain('### Step 2: Load your full context');
		expect(result).toContain('### Step 3: Assess and report');
	});

	it('should include recall command with correct parameters', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('core/recall/execute.sh');
		expect(result).toContain(`"agentId":"${baseConfig.sessionName}"`);
		expect(result).toContain(`"context":"${baseConfig.role} session startup`);
		expect(result).toContain(`"projectPath":"${baseConfig.projectPath}"`);
	});

	it('should include get-my-context command with correct parameters', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('core/get-my-context/execute.sh');
		expect(result).toContain(`"agentId":"${baseConfig.sessionName}"`);
		expect(result).toContain(`"agentRole":"${baseConfig.role}"`);
	});

	it('should include assessment checklist', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Check for unfinished work');
		expect(result).toContain('Check for pending blockers');
		expect(result).toContain('Report status');
	});

	it('should include mandatory warning', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Do NOT skip these steps');
		expect(result).toContain('Context recovery prevents duplicate work');
	});

	it('should use agentSkillsPath for commands', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain(`bash ${baseConfig.agentSkillsPath}/core/recall`);
		expect(result).toContain(`bash ${baseConfig.agentSkillsPath}/core/get-my-context`);
	});

	it('should use projectRoot when projectPath is undefined', async () => {
		const noPathConfig: ModuleConfig = {
			...baseConfig,
			projectPath: undefined,
		};
		const result = await module.build(noPathConfig);

		expect(result).toContain(baseConfig.projectRoot);
		expect(result).not.toContain('undefined');
	});

	it('should adapt role in recall context string', async () => {
		const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
		const result = await module.build(orchConfig);

		expect(result).toContain('"context":"orchestrator session startup');
	});

	it('should produce output in markdown format', async () => {
		const result = await module.build(baseConfig);
		const lines = result.split('\n');

		// First line is the heading
		expect(lines[0]).toBe('## Session Recovery Protocol (MANDATORY)');
		// Contains code blocks
		expect(result).toContain('```bash');
		expect(result).toContain('```');
	});
});
