import { DefaultExecutionLoopModule } from './default-execution-loop.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('DefaultExecutionLoopModule', () => {
	let module: DefaultExecutionLoopModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-leo-21a5477e',
		memberId: '21a5477e-ec10-4e45-8cae-8b55e232e04e',
		role: 'developer',
		teamId: '28a4ac10-f37f-4286-ad8c-6926a0e177f5',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new DefaultExecutionLoopModule();
	});

	describe('metadata', () => {
		it('should have name = default-execution-loop', () => {
			expect(module.name).toBe('default-execution-loop');
		});

		it('should sit at priority 3.8 (between lazy-anti-patterns=3.7 and memory-reference=4)', () => {
			expect(module.priority).toBe(3.8);
		});

		it('should declare a token budget large enough for the static block', () => {
			expect(module.maxTokens).toBeGreaterThanOrEqual(150);
		});

		it('should be non-compactable (behavioral mandate never truncates)', () => {
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
			expect(module.shouldInclude({ ...baseConfig, role: 'content-strategist' })).toBe(true);
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
		it('should emit the ## Default Execution Loop H2 header', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('## Default Execution Loop');
		});

		it('should open with the active anti-passive directive', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('When assigned a task, do not wait passively.');
		});

		it('should declare the loop termination conditions', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('Loop until done, blocked, or explicitly reassigned:');
		});

		it('should emit exactly 8 numbered steps in the canonical order', async () => {
			const out = await module.build(baseConfig);
			const stepLines = out.split('\n').filter((line) => /^\d+\. /.test(line));
			expect(stepLines).toHaveLength(8);

			// Verbatim ordering per spec lines 340-347
			expect(stepLines[0]).toBe('1. Restate the expected outcome in one sentence.');
			expect(stepLines[1]).toBe('2. Identify the fastest safe path to produce a usable result.');
			expect(stepLines[2]).toBe('3. Execute immediately.');
			expect(stepLines[3]).toBe('4. Run cheapest meaningful validation.');
			expect(stepLines[4]).toBe('5. If validation fails, fix and retry.');
			expect(stepLines[5]).toBe('6. If blocked by missing goal/outcome/eval, escalate to your TL.');
			expect(stepLines[6]).toBe('7. If blocked by implementation detail, decide reasonably and continue.');
			expect(stepLines[7]).toBe(
				'8. Report only when you have a result, blocker, or decision exceeding your authority.',
			);
		});

		it('should encode the TL-escalation trigger (missing goal/outcome/eval)', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/blocked by missing goal\/outcome\/eval/);
		});

		it('should encode the self-decide trigger (implementation detail)', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/blocked by implementation detail, decide reasonably/);
		});

		it('should encode the report gate (result, blocker, or decision exceeding authority)', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/result, blocker, or decision exceeding your authority/);
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
				'content-strategist',
				'fullstack-dev',
				'backend-developer',
				'frontend-developer',
				'ops',
				'tpm',
				'ux-designer',
				'generalist',
				'qa',
				'architect',
			];
			const outputs = await Promise.all(roles.map((role) => module.build({ ...baseConfig, role })));
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
