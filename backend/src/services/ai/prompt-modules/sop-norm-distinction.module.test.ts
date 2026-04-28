/**
 * Tests for SOPNormDistinctionModule.
 *
 * Validates the prompt-layer SOP-vs-Norm distinction module per
 * `.crewly/tasks/autonomy_v1/follow-up/sop-norm-prompt-module.md`
 * acceptance criteria.
 *
 * @module services/ai/prompt-modules/sop-norm-distinction.module.test
 */

import { SOPNormDistinctionModule } from './sop-norm-distinction.module.js';
import { ModuleConfig, estimateTokens } from './prompt-module.interface.js';

describe('SOPNormDistinctionModule', () => {
	let module: SOPNormDistinctionModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-sam-dd2b46f7',
		memberId: 'dd2b46f7-bb70-4aeb-b980-3f85b724aa9c',
		role: 'developer',
		teamId: '817a1aeb-b04e-45dd-bdbc-be5cbc4345f1',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new SOPNormDistinctionModule();
	});

	describe('metadata', () => {
		it('exposes the expected name and priority slot', () => {
			expect(module.name).toBe('sop_norm_distinction');
			// Just after learning_references (10) so the SOP/Norm lens is set
			// before downstream behavioural sections.
			expect(module.priority).toBe(11);
		});

		it('declares a maxTokens budget that accommodates all 6 spec sections', () => {
			// Spec acceptance criterion lists "< 450" but that undercounts the
			// verbatim skeleton. Authoritative budget is 1100 with ~9% headroom
			// over the actual ~1009-token output. compactable=true preserves the
			// assembler's ability to trim under pressure.
			expect(module.maxTokens).toBe(1100);
		});

		it('is compactable so prompt assembler can trim under budget pressure', () => {
			expect(module.compactable).toBe(true);
		});
	});

	describe('shouldInclude', () => {
		it('always returns true regardless of role', () => {
			expect(module.shouldInclude(baseConfig)).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'orchestrator' })).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'team-lead' })).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, role: 'qa' })).toBe(true);
		});

		it('always returns true regardless of evalMode / runtimeType', () => {
			expect(module.shouldInclude({ ...baseConfig, evalMode: true })).toBe(true);
			expect(module.shouldInclude({ ...baseConfig, runtimeType: 'gemini-cli' })).toBe(true);
		});

		it('returns true even when projectPath is missing', () => {
			expect(module.shouldInclude({ ...baseConfig, projectPath: undefined })).toBe(true);
		});
	});

	describe('build — section structure', () => {
		it('renders the top-level heading', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('## SOP vs Team Norm');
		});

		it('renders all 6 required sections', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('### Definitions');
			expect(out).toContain('### Reading rules');
			expect(out).toContain('### Naming + placement rules');
			expect(out).toContain('### Reconciliation rules');
			expect(out).toContain('### Owner Communication Discipline');
			expect(out).toContain('### Why this matters');
		});
	});

	describe('build — Definitions section (3 bullets)', () => {
		it('defines SOP, Team Norm, and Hybrid', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/\*\*SOP\*\*/);
			expect(out).toMatch(/\*\*Team Norm\*\*/);
			expect(out).toMatch(/\*\*Hybrid\*\*/);
		});

		it('frames SOP as step-by-step procedural', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/SOP.*step-by-step/i);
		});

		it('frames Norm as behavioral/collaboration covenant', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Norm.*(behavioral|covenant)/i);
		});
	});

	describe('build — Reading rules (4 items)', () => {
		it('includes the 4 numbered reading rules', async () => {
			const out = await module.build(baseConfig);
			const readingSection = extractSection(out, 'Reading rules');
			expect(readingSection).toMatch(/^1\./m);
			expect(readingSection).toMatch(/^2\./m);
			expect(readingSection).toMatch(/^3\./m);
			expect(readingSection).toMatch(/^4\./m);
		});

		it('declares YAML frontmatter type: as the source of truth', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Source of truth.*YAML frontmatter/);
			expect(out).toContain('`type:`');
		});

		it('references get-sops skill and warns against stepping through a Norm', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('get-sops');
			expect(out).toMatch(/Do NOT step-through a Norm/);
		});

		it('directs ambiguity to the team-leader', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/team-leader/);
		});
	});

	describe('build — Naming + placement rules (4 items)', () => {
		it('includes the 4 numbered naming + placement rules', async () => {
			const out = await module.build(baseConfig);
			const section = extractSection(out, 'Naming \\+ placement rules');
			expect(section).toMatch(/^1\./m);
			expect(section).toMatch(/^2\./m);
			expect(section).toMatch(/^3\./m);
			expect(section).toMatch(/^4\./m);
		});

		it('specifies filename prefix convention', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('`sop-<name>.md`');
			expect(out).toContain('`norm-<name>.md`');
			expect(out).toContain('`hybrid-<name>.md`');
		});

		it('mandates YAML frontmatter and calls it the contract', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('YAML frontmatter');
			expect(out).toMatch(/frontmatter `type:` is the contract/);
		});

		it('specifies subdirectory placement', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('`sops/sops/`');
			expect(out).toContain('`sops/norms/`');
			expect(out).toContain('`sops/hybrids/`');
		});

		it('requires section-level HTML comments inside hybrid docs', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/<!-- type: sop -->/);
			expect(out).toMatch(/<!-- type: norm -->/);
		});
	});

	describe('build — Reconciliation rules (4 items)', () => {
		it('includes the 4 numbered reconciliation rules', async () => {
			const out = await module.build(baseConfig);
			const section = extractSection(out, 'Reconciliation rules');
			expect(section).toMatch(/^1\./m);
			expect(section).toMatch(/^2\./m);
			expect(section).toMatch(/^3\./m);
			expect(section).toMatch(/^4\./m);
		});

		it('declares "Flag, don\'t merge" as the first reconciliation rule', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Flag, don't merge\./);
		});

		it('directs reconciliation decisions to the team-leader', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Escalate to team-leader/);
			expect(out).toMatch(/TL owns reconciliation decisions/);
		});

		it('declares the mtime → version → owner coexistence priority', async () => {
			const out = await module.build(baseConfig);
			expect(out).toContain('`mtime`');
			expect(out).toContain('`version:`');
			expect(out).toContain('`owner:`');
		});

		it('mandates "Never delete" + status: deprecated tagging + audit retention', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Never delete\./);
			expect(out).toContain('`status: deprecated`');
			expect(out).toMatch(/audit/);
		});

		it('explicitly aligns with Norm v0.2 "extend not replace"', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/extend not replace/);
			expect(out).toMatch(/Norm v0\.2/);
		});
	});

	describe('build — Owner Communication Discipline (3 norms as one family)', () => {
		it('includes all 3 numbered norms', async () => {
			const out = await module.build(baseConfig);
			const section = extractSection(out, 'Owner Communication Discipline');
			expect(section).toMatch(/^1\./m);
			expect(section).toMatch(/^2\./m);
			expect(section).toMatch(/^3\./m);
		});

		it('names the family as "owner attention discipline"', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/owner attention discipline/);
		});

		it('includes the silent-by-default norm', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Silent by default\./);
			expect(out).toMatch(/Heartbeats/);
		});

		it('includes the outcomes-not-narrate norm', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Deliver outcomes, not narrate progress\./);
			expect(out).toMatch(/lead with the conclusion/);
		});

		it('includes the thread-scope-discipline norm', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Thread Scope Discipline\./);
			expect(out).toMatch(/no cross-thread sidebars/);
		});
	});

	describe('build — Why this matters', () => {
		it('contrasts SOP vs Norm with a concrete example', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/An SOP says.*ship a PR/);
			expect(out).toMatch(/A Norm says.*branch-guard/);
		});

		it('explains why silent merging is harmful', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Silent merging.*erases/);
		});

		it('explains why owner-attention norms compound', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/Owner attention is finite/);
			expect(out).toMatch(/compound/);
		});
	});

	describe('build — token budget', () => {
		it('produces output that fits within the declared maxTokens soft cap', async () => {
			const out = await module.build(baseConfig);
			const tokens = estimateTokens(out);
			expect(tokens).toBeLessThanOrEqual(module.maxTokens);
			// Sanity floor — output must be substantive enough to cover all 6
			// required sections (Definitions, Reading, Naming, Reconciliation,
			// Owner Communication, Why) plus mandated sub-items. A degenerate
			// short build would otherwise trivially pass the upper cap.
			expect(tokens).toBeGreaterThan(700);
		});
	});

	describe('idempotency', () => {
		it('two calls produce the same output (no hidden state)', async () => {
			const a = await module.build(baseConfig);
			const b = await module.build(baseConfig);
			expect(a).toEqual(b);
		});
	});
});

/**
 * Extract a section of the markdown output between `### <title>` and the next
 * `###` heading (or end-of-string). Used so per-section assertions don't
 * false-positive on numbered list items that live in other sections.
 *
 * NOTE: We deliberately do NOT use the `m` flag here — with multiline mode,
 * `$` would match at every newline and the non-greedy `*?` would capture only
 * the title line. Letting `$` match end-of-string only allows the lookahead
 * to find the next `### ` properly.
 */
function extractSection(text: string, titlePattern: string): string {
	const re = new RegExp(`###[ \\t]+${titlePattern}[^\\n]*\\n([\\s\\S]*?)(?=\\n###[ \\t]|$)`);
	const match = text.match(re);
	return match ? match[1] ?? '' : '';
}
