import { RequestContractModule } from './request-contract.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('RequestContractModule', () => {
	let module: RequestContractModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-leo-21a5477e',
		memberId: '21a5477e-ec10-4e45-8cae-8b55e232e04e',
		role: 'developer',
		teamId: '817a1aeb-b04e-45dd-bdbc-be5cbc4345f1',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new RequestContractModule();
	});

	describe('metadata', () => {
		it('should have name = request-contract', () => {
			expect(module.name).toBe('request-contract');
		});

		it('should sit at priority 3.6 (between decision-rights=3.5 and memory-reference=4)', () => {
			expect(module.priority).toBe(3.6);
		});

		it('should sit immediately after DecisionRightsModule (priority 3.5)', () => {
			expect(module.priority).toBeGreaterThan(3.5);
			expect(module.priority).toBeLessThan(4);
		});

		it('should declare a token budget large enough for the largest (orchestrator) variant', () => {
			expect(module.maxTokens).toBeGreaterThanOrEqual(400);
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

	describe('build — orchestrator role-shape', () => {
		it('should emit ## Request Contract H2 when role === orchestrator', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).toContain('## Request Contract');
		});

		it('should emit ## Request Contract H2 when orgRole === orchestrator (overrides role)', async () => {
			const out = await module.build({
				...baseConfig,
				role: 'developer',
				orgRole: 'orchestrator',
			});
			expect(out).toContain('## Request Contract');
		});

		it('should emit the seven canonical fields in the table', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).toContain('**Goal**');
			expect(out).toContain('**Expected Outcome**');
			expect(out).toContain('**Eval Criteria**');
			expect(out).toContain('Constraints');
			expect(out).toContain('Decision Rights');
			expect(out).toContain('Escalation Conditions');
			expect(out).toContain('**Done Definition**');
		});

		it('should mark Goal / Expected Outcome / Eval Criteria / Done Definition as YES required', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			// Spec verbatim: G+O+E + Done are the YES-required fields.
			const goalLine = out.split('\n').find((l) => l.includes('**Goal**'));
			const outcomeLine = out.split('\n').find((l) => l.includes('**Expected Outcome**'));
			const evalLine = out.split('\n').find((l) => l.includes('**Eval Criteria**'));
			const doneLine = out.split('\n').find((l) => l.includes('**Done Definition**'));
			expect(goalLine).toMatch(/YES/);
			expect(outcomeLine).toMatch(/YES/);
			expect(evalLine).toMatch(/YES/);
			expect(doneLine).toMatch(/YES/);
		});

		it('should pin the G+O+E mandatory floor for every delegated subtask', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).toMatch(/Every delegated subtask MUST carry Goal \+ Expected Outcome \+ Eval Criteria/);
		});

		it('should require TL to reject malformed briefs', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).toMatch(/Team Lead is required to reject any subtask brief missing these three/);
		});

		it('should pin "conversation history is recall only — pool gates work-in-flight"', async () => {
			// Root cause from 2026-05-08 dogfood: orc's claude conversation
			// memory persisted "I owe Sam a sign-off" across PTY restarts;
			// the pool had been purged but history hadn't, so orc resurrected
			// Sam via a follow-up send-message. Fix lives in the prompt:
			// history is for recall, the pool is the truth for what's still
			// in flight. If a refactor strips this section, this test fails
			// loud.
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).toMatch(/Conversation History — Recall Only/);
			expect(out).toMatch(/recall only/);
			expect(out).toMatch(/decided by the pool/);
		});

		it('should NOT include the TL Brief Reception Protocol header for the orchestrator', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).not.toContain('## Brief Reception Protocol');
		});

		it('should NOT include the worker reminder header for the orchestrator', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			expect(out).not.toContain('## Request Contract — What You Should See');
		});
	});

	describe('build — team-lead role-shape', () => {
		it('should emit ## Brief Reception Protocol when orgRole === team-lead', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			expect(out).toContain('## Brief Reception Protocol');
		});

		it('should emit ## Brief Reception Protocol when canDelegate === true', async () => {
			const out = await module.build({ ...baseConfig, canDelegate: true });
			expect(out).toContain('## Brief Reception Protocol');
		});

		it('should NOT emit Brief Reception Protocol when canDelegate is undefined and orgRole !== team-lead', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).not.toContain('## Brief Reception Protocol');
		});

		it('should encode the three-step verify / push-back / propagate-verbatim contract', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			expect(out).toMatch(/1\.\s+\*\*Verify\*\*/);
			expect(out).toMatch(/2\.\s+\*\*Push back\*\*/);
			expect(out).toMatch(/3\.\s+\*\*Propagate verbatim\*\*/);
		});

		it('should explicitly forbid proceeding when G+O+E is missing', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			expect(out).toMatch(/do not proceed, do not start decomposition, do not fan out work/);
		});

		it('should require G+O+E to be propagated verbatim to children', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			expect(out).toMatch(/Propagate verbatim/);
			expect(out).toMatch(/Workers should never have to ask you what success looks like/);
		});

		it('should NOT include the orchestrator field table for the TL', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			expect(out).not.toContain('| Field | Required | What it means |');
		});

		it('should NOT include the worker reminder header for the TL', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			expect(out).not.toContain('## Request Contract — What You Should See');
		});
	});

	describe('build — worker / executor role-shape', () => {
		it('should emit the worker reminder for role === developer', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).toContain('## Request Contract — What You Should See');
		});

		it('should emit the worker reminder for role === auditor', async () => {
			const out = await module.build({ ...baseConfig, role: 'auditor' });
			expect(out).toContain('## Request Contract — What You Should See');
		});

		it('should emit the worker reminder for orgRole === executor', async () => {
			const out = await module.build({ ...baseConfig, role: 'researcher', orgRole: 'executor' });
			expect(out).toContain('## Request Contract — What You Should See');
		});

		it('should list the three required fields the worker should expect', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).toMatch(/-\s+\*\*Goal\*\*/);
			expect(out).toMatch(/-\s+\*\*Expected Outcome\*\*/);
			expect(out).toMatch(/-\s+\*\*Eval Criteria\*\*/);
		});

		it('should instruct the worker to ask the delegator if any field is missing', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).toMatch(/ask the delegator/);
			expect(out).toMatch(/before starting/);
		});

		it('should explicitly forbid the worker from inventing the contract themselves', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).toMatch(/Do not invent the contract yourself/);
		});

		it('should NOT include the orchestrator field table for the worker', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).not.toContain('| Field | Required | What it means |');
		});

		it('should NOT include the TL Brief Reception Protocol for the worker', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			expect(out).not.toContain('## Brief Reception Protocol');
		});
	});

	describe('build — role-shape resolution priority', () => {
		it('should pick orchestrator over team-lead when both signals are set', async () => {
			// orchestrator wins via role check; canDelegate=true would otherwise route to TL.
			const out = await module.build({
				...baseConfig,
				role: 'orchestrator',
				canDelegate: true,
			});
			expect(out).toContain('## Request Contract');
			expect(out).not.toContain('## Brief Reception Protocol');
		});

		it('should pick orchestrator over team-lead when orgRole=orchestrator + canDelegate=true', async () => {
			const out = await module.build({
				...baseConfig,
				role: 'developer',
				orgRole: 'orchestrator',
				canDelegate: true,
			});
			expect(out).toContain('## Request Contract');
			expect(out).not.toContain('## Brief Reception Protocol');
		});

		it('should pick team-lead over worker when canDelegate=true even with executor role', async () => {
			const out = await module.build({
				...baseConfig,
				role: 'developer',
				canDelegate: true,
			});
			expect(out).toContain('## Brief Reception Protocol');
			expect(out).not.toContain('## Request Contract — What You Should See');
		});

		it('should fall back to worker when neither orchestrator nor TL signals fire', async () => {
			const out = await module.build({
				...baseConfig,
				role: 'researcher',
				canDelegate: false,
			});
			expect(out).toContain('## Request Contract — What You Should See');
		});
	});

	describe('build — content-stability across configurations', () => {
		it('should emit byte-identical orchestrator content regardless of unrelated fields', async () => {
			const a = await module.build({ ...baseConfig, role: 'orchestrator', autonomyLevel: 'directed' });
			const b = await module.build({ ...baseConfig, role: 'orchestrator', autonomyLevel: 'domain_autonomous' });
			const c = await module.build({ ...baseConfig, role: 'orchestrator', teamId: 'other-team' });
			expect(a).toBe(b);
			expect(b).toBe(c);
		});

		it('should emit byte-identical TL content regardless of unrelated fields', async () => {
			const a = await module.build({ ...baseConfig, orgRole: 'team-lead', role: 'team-leader' });
			const b = await module.build({ ...baseConfig, orgRole: 'team-lead', role: 'developer' });
			const c = await module.build({ ...baseConfig, canDelegate: true, role: 'qa-engineer' });
			expect(a).toBe(b);
			expect(b).toBe(c);
		});

		it('should emit byte-identical worker content regardless of role label', async () => {
			const roles = ['developer', 'researcher', 'auditor', 'qa-engineer', 'designer', 'sales', 'support'];
			const outputs = await Promise.all(
				roles.map((role) => module.build({ ...baseConfig, role })),
			);
			const first = outputs[0];
			for (const out of outputs) {
				expect(out).toBe(first);
			}
		});
	});

	describe('build — token budget headroom', () => {
		it('orchestrator block should fit comfortably under maxTokens', async () => {
			const out = await module.build({ ...baseConfig, role: 'orchestrator' });
			const estimatedTokens = Math.ceil(out.length / 4);
			expect(estimatedTokens).toBeLessThan(module.maxTokens);
		});

		it('team-lead block should fit comfortably under maxTokens', async () => {
			const out = await module.build({ ...baseConfig, orgRole: 'team-lead' });
			const estimatedTokens = Math.ceil(out.length / 4);
			expect(estimatedTokens).toBeLessThan(module.maxTokens);
		});

		it('worker block should fit comfortably under maxTokens', async () => {
			const out = await module.build({ ...baseConfig, role: 'developer' });
			const estimatedTokens = Math.ceil(out.length / 4);
			expect(estimatedTokens).toBeLessThan(module.maxTokens);
		});
	});
});
