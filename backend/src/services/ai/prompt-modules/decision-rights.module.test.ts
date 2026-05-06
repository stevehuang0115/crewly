import { DecisionRightsModule } from './decision-rights.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('DecisionRightsModule', () => {
	let module: DecisionRightsModule;

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
		module = new DecisionRightsModule();
	});

	describe('metadata', () => {
		it('should have name = decision-rights', () => {
			expect(module.name).toBe('decision-rights');
		});

		it('should sit at priority 3.5 (between role-boundary=3 and memory-reference=4)', () => {
			expect(module.priority).toBe(3.5);
		});

		it('should declare a token budget large enough for the static block', () => {
			expect(module.maxTokens).toBeGreaterThanOrEqual(200);
		});

		it('should be non-compactable (authority text never truncates)', () => {
			expect(module.compactable).toBe(false);
		});
	});

	describe('shouldInclude', () => {
		it('should always include regardless of role', () => {
			expect(module.shouldInclude(baseConfig)).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'orchestrator' })).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'team-leader' })).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'developer' })).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'auditor' })).toBe(true);
		});

		it('should include when org-role fields are absent', () => {
			expect(
				module.shouldInclude({
					sessionName: 'minimal',
					memberId: 'm',
					role: 'developer',
					agentSkillsPath: '/a',
					tlSkillsPath: '/t',
					projectRoot: '/r',
				}),
			).toBe(true);
		});
	});

	describe('build — content contract (verbatim per spec)', () => {
		it('should emit the ## Decision Rights H2 header', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('## Decision Rights');
		});

		it('should emit the ## Escalation Chain H2 header', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('## Escalation Chain');
		});

		it('should emit exactly five "Decide autonomously when" bullets', async () => {
			const out = await module.build(baseConfig);
			const decideBlockMatch = out.match(/\*\*Decide autonomously when:\*\*\n([\s\S]*?)\n\n\*\*Escalate when:\*\*/);
			expect(decideBlockMatch).not.toBeNull();
			const decideBullets = (decideBlockMatch![1].match(/^- /gm) || []).length;
			expect(decideBullets).toBe(5);
		});

		it('should emit exactly five "Escalate when" bullets', async () => {
			const out = await module.build(baseConfig);
			const escalateBlockMatch = out.match(/\*\*Escalate when:\*\*\n([\s\S]*?)\n\n## Escalation Chain/);
			expect(escalateBlockMatch).not.toBeNull();
			const escalateBullets = (escalateBlockMatch![1].match(/^- /gm) || []).length;
			expect(escalateBullets).toBe(5);
		});

		it('should encode the four-link chain Worker → Team Lead → Orchestrator → Owner', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('**Worker → Team Lead → Orchestrator → Owner**');
		});

		it('should explicitly forbid worker-to-owner direct escalation', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Workers do \*\*not\*\* escalate directly to the owner/);
		});

		it('should describe TL escalation gate (scope / priority / acceptance criteria)', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Team Leads.*scope.*priority.*acceptance criteria/);
		});

		it('should describe orchestrator role (cross-team + owner-facing acceptance)', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Orchestrator owns cross-team and owner-facing acceptance/);
		});

		it('should pin the closed set of owner-consult triggers', async () => {
			const out = await module.build(baseConfig);
			// Spec verbatim: goal change, scope change, customer-facing commitment,
			// irreversible expense, or strategic direction.
			expect(out).toContain('goal change');
			expect(out).toContain('scope change');
			expect(out).toContain('customer-facing commitment');
			expect(out).toContain('irreversible expense');
			expect(out).toContain('strategic direction');
		});
	});

	describe('build — role-invariance', () => {
		it('should emit byte-identical content for every role', async () => {
			const roles = [
				'orchestrator',
				'team-leader',
				'developer',
				'researcher',
				'auditor',
				'qa-engineer',
				'designer',
				'product-manager',
				'sales',
				'support',
			];
			const outputs = await Promise.all(
				roles.map((role) => module.build({ ...baseConfig, role })),
			);
			const first = outputs[0];
			for (const out of outputs) {
				expect(out).toBe(first);
			}
		});

		it('should emit byte-identical content regardless of org-role / autonomy', async () => {
			const a = await module.build({ ...baseConfig, orgRole: 'orchestrator', autonomyLevel: 'domain_autonomous' });
			const b = await module.build({ ...baseConfig, orgRole: 'executor', autonomyLevel: 'directed' });
			const c = await module.build({ ...baseConfig, orgRole: 'team-lead', autonomyLevel: 'bounded' });
			expect(a).toBe(b);
			expect(b).toBe(c);
		});
	});

	describe('build — token budget headroom', () => {
		it('should fit comfortably under maxTokens (estimated)', async () => {
			const out = await module.build(baseConfig);
			// Rough token estimate: ~4 chars per token. We declare 320 tokens,
			// the actual block should sit well under that.
			const estimatedTokens = Math.ceil(out.length / 4);
			expect(estimatedTokens).toBeLessThan(module.maxTokens);
		});
	});
});
