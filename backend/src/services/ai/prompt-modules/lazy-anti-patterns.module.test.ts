import { LazyAntiPatternsModule } from './lazy-anti-patterns.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('LazyAntiPatternsModule', () => {
	let module: LazyAntiPatternsModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-max-358c7cb7',
		memberId: '358c7cb7-eb20-482a-87b2-655eb8cdde4e',
		role: 'developer',
		teamId: '28a4ac10-f37f-4286-ad8c-6926a0e177f5',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new LazyAntiPatternsModule();
	});

	describe('metadata', () => {
		it('should have name = lazy-anti-patterns', () => {
			expect(module.name).toBe('lazy-anti-patterns');
		});

		it('should sit at priority 3.7 (after request-contract=3.6, before memory-reference=4)', () => {
			expect(module.priority).toBe(3.7);
		});

		it('should declare a token budget large enough for the seven-bullet block', () => {
			expect(module.maxTokens).toBeGreaterThanOrEqual(150);
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
		it('should emit the ## Lazy Behavior Anti-Patterns H2 header', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('## Lazy Behavior Anti-Patterns');
		});

		it('should emit the "You are failing the task if you:" lead-in', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('You are failing the task if you:');
		});

		it('should emit exactly seven anti-pattern bullets', async () => {
			const out = await module.build(baseConfig);
			const blockMatch = out.match(/You are failing the task if you:\n([\s\S]*)$/);
			expect(blockMatch).not.toBeNull();
			const bullets = (blockMatch![1].match(/^- /gm) || []).length;
			expect(bullets).toBe(7);
		});

		// 7 anti-patterns covered, verbatim per spec lines 386-401:
		it('should include anti-pattern: ask-owner-impl-detail', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Ask the human for an implementation detail you could decide yourself.');
		});

		it('should include anti-pattern: report-plan-no-execute', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Report a plan without executing when execution is possible.');
		});

		it('should include anti-pattern: schedule-followup-instead-of-in-session', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Schedule follow-up instead of continuing work in-session.');
		});

		it('should include anti-pattern: mark-blocked-no-try', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Mark blocked without trying at least one reasonable path.');
		});

		it('should include anti-pattern: stop-partial-no-next-action', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Stop after partial progress without assigning next action.');
		});

		it('should include anti-pattern: delegate-without-check', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Delegate without checking completion.');
		});

		it('should include anti-pattern: status-without-artifact', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain(
				'Produce status updates but no artifact, code, decision, or verified result.',
			);
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
			// Rough token estimate: ~4 chars per token. We declare 200 tokens,
			// the actual block should sit well under that.
			const estimatedTokens = Math.ceil(out.length / 4);
			expect(estimatedTokens).toBeLessThan(module.maxTokens);
		});
	});
});
