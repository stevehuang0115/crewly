import { RoleBoundaryModule } from './role-boundary.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

/**
 * Tests for the RoleBoundaryModule.
 *
 * Verifies that the module produces correct boundary content
 * for each organizational role (orchestrator, team-lead, executor)
 * and enforces the Try-Before-Refuse protocol across all roles.
 */
describe('RoleBoundaryModule', () => {
	let module: RoleBoundaryModule;

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
		module = new RoleBoundaryModule();
	});

	/**
	 * Verify module metadata matches expected values.
	 */
	it('should have correct metadata', () => {
		expect(module.name).toBe('role-boundary');
		expect(module.priority).toBe(3);
		expect(module.maxTokens).toBe(800);
		expect(module.compactable).toBe(false);
	});

	/**
	 * shouldInclude must always return true regardless of config.
	 */
	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, orgRole: 'orchestrator' })).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, orgRole: undefined })).toBe(true);
	});

	/**
	 * Orchestrator orgRole produces orchestrator-specific boundary content
	 * emphasizing message routing and forbidding strategy/implementation.
	 */
	it('should produce orchestrator boundary content for orchestrator orgRole', async () => {
		const config: ModuleConfig = { ...baseConfig, orgRole: 'orchestrator' };
		const result = await module.build(config);

		expect(result).toContain('User secretary');
		expect(result).toContain('message router');
		expect(result).toContain('What You Are NOT');
		expect(result).toContain('Strategy maker');
		expect(result).toContain('Code writer');
		expect(result).toContain('Event Response Rules');
	});

	/**
	 * Team Lead orgRole produces TL-specific boundary content
	 * emphasizing delegation, planning, and quality verification.
	 */
	it('should produce team-lead boundary content for team-lead orgRole', async () => {
		const config: ModuleConfig = { ...baseConfig, orgRole: 'team-lead' };
		const result = await module.build(config);

		expect(result).toContain('Objective owner');
		expect(result).toContain('Delegator');
		expect(result).toContain('result aggregator');
		expect(result).toContain('Quality verifier');
		expect(result).toContain('Workflow Ownership');
	});

	/**
	 * Executor orgRole produces executor-specific boundary content
	 * emphasizing scoped implementation and structured block reports.
	 */
	it('should produce executor boundary content for executor orgRole', async () => {
		const config: ModuleConfig = { ...baseConfig, orgRole: 'executor' };
		const result = await module.build(config);

		expect(result).toContain('Scoped implementer');
		expect(result).toContain('tester');
		expect(result).toContain('what_tried');
		expect(result).toContain('what_failed');
		expect(result).toContain('what_needed');
		expect(result).toContain('partial_result');
		expect(result).toContain('Structured Block Report');
	});

	/**
	 * When orgRole is not set, the module defaults to executor boundaries.
	 */
	it('should default to executor content when orgRole is not set', async () => {
		const config: ModuleConfig = { ...baseConfig };
		// Ensure orgRole is undefined
		delete config.orgRole;
		const result = await module.build(config);

		expect(result).toContain('Scoped implementer');
		expect(result).toContain('what_tried');
		expect(result).toContain('Execution Rules');
	});

	/**
	 * All role variants include the "Role Boundaries" heading.
	 */
	it('should include Role Boundaries heading for all roles', async () => {
		const orchestratorResult = await module.build({ ...baseConfig, orgRole: 'orchestrator' });
		const tlResult = await module.build({ ...baseConfig, orgRole: 'team-lead' });
		const executorResult = await module.build({ ...baseConfig, orgRole: 'executor' });

		expect(orchestratorResult).toContain('## Role Boundaries');
		expect(tlResult).toContain('## Role Boundaries');
		expect(executorResult).toContain('## Role Boundaries');
	});

	/**
	 * All role variants include the Try-Before-Refuse protocol section.
	 */
	it('should include Try-Before-Refuse section for all roles', async () => {
		const orchestratorResult = await module.build({ ...baseConfig, orgRole: 'orchestrator' });
		const tlResult = await module.build({ ...baseConfig, orgRole: 'team-lead' });
		const executorResult = await module.build({ ...baseConfig, orgRole: 'executor' });

		expect(orchestratorResult).toContain('Try-Before-Refuse');
		expect(tlResult).toContain('Try-Before-Refuse');
		expect(executorResult).toContain('Try-Before-Refuse');
	});

	/**
	 * Each role produces distinct content — no cross-contamination.
	 */
	it('should produce distinct content per role', async () => {
		const orchestratorResult = await module.build({ ...baseConfig, orgRole: 'orchestrator' });
		const tlResult = await module.build({ ...baseConfig, orgRole: 'team-lead' });
		const executorResult = await module.build({ ...baseConfig, orgRole: 'executor' });

		// Orchestrator-only content
		expect(orchestratorResult).toContain('Event Response Rules');
		expect(tlResult).not.toContain('Event Response Rules');
		expect(executorResult).not.toContain('Event Response Rules');

		// TL-only content
		expect(tlResult).toContain('Workflow Ownership');
		expect(orchestratorResult).not.toContain('Workflow Ownership');
		expect(executorResult).not.toContain('Workflow Ownership');

		// Executor-only content
		expect(executorResult).toContain('Structured Block Report');
		expect(orchestratorResult).not.toContain('Structured Block Report');
		expect(tlResult).not.toContain('Structured Block Report');
	});
});
