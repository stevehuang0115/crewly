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
		expect(module.maxTokens).toBe(1200);
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

	/**
	 * All roles include the Guidance Priority Chain for conflict resolution.
	 */
	it('should include Guidance Priority Chain for all roles', async () => {
		const orchestratorResult = await module.build({ ...baseConfig, orgRole: 'orchestrator' });
		const tlResult = await module.build({ ...baseConfig, orgRole: 'team-lead' });
		const executorResult = await module.build({ ...baseConfig, orgRole: 'executor' });

		for (const result of [orchestratorResult, tlResult, executorResult]) {
			expect(result).toContain('Guidance Priority Chain');
			expect(result).toContain('System Safety / Risk Policy');
			expect(result).toContain('Role Boundary');
			expect(result).toContain('Explicit Task Contract');
			expect(result).toContain('Team Norm');
			expect(result).toContain('Relevant SOP');
			expect(result).toContain('Memory / Heuristics');
			expect(result).toContain('may NEVER override higher-priority constraints');
		}
	});

	/**
	 * All roles include Core Execution Principles.
	 */
	it('should include Core Execution Principles for all roles', async () => {
		const orchestratorResult = await module.build({ ...baseConfig, orgRole: 'orchestrator' });
		const tlResult = await module.build({ ...baseConfig, orgRole: 'team-lead' });
		const executorResult = await module.build({ ...baseConfig, orgRole: 'executor' });

		for (const result of [orchestratorResult, tlResult, executorResult]) {
			expect(result).toContain('Core Execution Principles');
			expect(result).toContain('Execute within delegated boundaries');
			expect(result).toContain('Seek alignment before changing scope');
			expect(result).toContain('Decomposition stays local');
		}
	});

	/**
	 * Executor includes Task Classification Gate for pre-execution classification.
	 */
	it('should include Task Classification Gate for executor', async () => {
		const result = await module.build({ ...baseConfig, orgRole: 'executor' });

		expect(result).toContain('Task Classification Gate');
		expect(result).toContain('direct_execution');
		expect(result).toContain('needs_alignment');
		expect(result).toContain('Alignment Request');
		expect(result).toContain('Scope change');
		expect(result).toContain('Alignment target');
	});

	/**
	 * Team Lead includes Task Contract Protocol for delegation.
	 */
	it('should include Task Contract Protocol for team-lead', async () => {
		const result = await module.build({ ...baseConfig, orgRole: 'team-lead' });

		expect(result).toContain('Task Contract Protocol');
		expect(result).toContain('Non-goals');
		expect(result).toContain('Acceptance criteria');
		expect(result).toContain('Output format');
		expect(result).toContain('Cutoff conditions');
		expect(result).toContain('Escalation triggers');
		expect(result).toContain('Decomposition Decision Rules');
	});

	/**
	 * Orchestrator includes narrowed scope constraints.
	 */
	it('should include orchestrator scope constraints', async () => {
		const result = await module.build({ ...baseConfig, orgRole: 'orchestrator' });

		expect(result).toContain('Orchestrator Scope Constraints');
		expect(result).toContain('Route, don\'t decide');
		expect(result).toContain('Never decompose tasks');
		expect(result).toContain('Never judge implementation quality');
	});

	/**
	 * Executor includes Task Acceptance Protocol.
	 */
	it('should include Task Acceptance Protocol for executor', async () => {
		const result = await module.build({ ...baseConfig, orgRole: 'executor' });

		expect(result).toContain('Task Acceptance Protocol');
		expect(result).toContain('understood_goal');
		expect(result).toContain('planned_approach');
		expect(result).toContain('out_of_scope');
		expect(result).toContain('identified_risks');
		expect(result).toContain('pre_classified');
	});

	// =========================================================================
	// WIRE-1 fail-fast misconfiguration guards (V4 + F-G)
	// =========================================================================

	/**
	 * V4 (Arch Veto #7): canDelegate=true && orgRole undefined → throw.
	 *
	 * The bug WIRE-1 fixes: pre-WIRE-1, the module silently fell back to the
	 * executor boundary when `orgRole` was undefined, so every TL agent in
	 * production rendered with the wrong boundary text. The throw forces
	 * callers to resolve `orgRole` via `deriveOrgRole(member, team)` before
	 * assembly.
	 */
	it('throws when canDelegate=true and orgRole is undefined (V4 — silent fallback bug)', async () => {
		const misconfig: ModuleConfig = {
			...baseConfig,
			canDelegate: true,
			// orgRole intentionally undefined
		};
		await expect(module.build(misconfig)).rejects.toThrow(
			/canDelegate=true but orgRole is undefined/,
		);
	});

	/**
	 * V4 detail: error message must mention the session for log correlation.
	 */
	it('error message includes the session name for log correlation', async () => {
		const misconfig: ModuleConfig = {
			...baseConfig,
			sessionName: 'crewly-product-sam-dd2b46f7',
			canDelegate: true,
		};
		await expect(module.build(misconfig)).rejects.toThrow(
			/session=crewly-product-sam-dd2b46f7/,
		);
	});

	/**
	 * F-G symmetric misconfig: canDelegate=false && orgRole='team-lead' → throw.
	 *
	 * Refuse to render TL authority for a member that explicitly cannot
	 * delegate. Either the caller mis-resolved orgRole or the member record
	 * itself contradicts the team-side hierarchy — fail loudly either way.
	 */
	it('throws when canDelegate=false and orgRole=team-lead (F-G symmetric misconfig)', async () => {
		const misconfig: ModuleConfig = {
			...baseConfig,
			canDelegate: false,
			orgRole: 'team-lead',
		};
		await expect(module.build(misconfig)).rejects.toThrow(
			/canDelegate=false but orgRole='team-lead'/,
		);
	});

	/**
	 * Negative — the V4 throw must NOT fire when canDelegate is undefined
	 * (the legacy path for non-TL agents whose record predates canDelegate
	 * being set). These render as executor and that is correct behaviour.
	 */
	it('does not throw when canDelegate is undefined and orgRole is undefined', async () => {
		const config: ModuleConfig = {
			...baseConfig,
			// canDelegate intentionally omitted; orgRole intentionally undefined
		};
		const result = await module.build(config);
		expect(result).toContain('## Role Boundaries');
		// Should render executor boundary (the correct fallback for non-TL members)
		expect(result).toContain('Scoped implementer');
	});

	/**
	 * Negative — the V4 throw must NOT fire on a properly configured TL
	 * (canDelegate=true AND orgRole resolved). This is the happy path.
	 */
	it('renders TL boundary when canDelegate=true and orgRole=team-lead', async () => {
		const config: ModuleConfig = {
			...baseConfig,
			canDelegate: true,
			orgRole: 'team-lead',
		};
		const result = await module.build(config);
		expect(result).toContain('Objective owner');
		expect(result).toContain('Delegator');
		expect(result).toContain('Quality verifier');
	});
});
