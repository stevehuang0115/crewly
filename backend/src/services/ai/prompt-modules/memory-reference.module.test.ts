import { MemoryReferenceModule, type SelfModelReaders } from './memory-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';
import { SELF_IMPROVEMENT_CONSTANTS } from '../../../constants.js';

/**
 * Build a readers stub with empty defaults, overridable per test.
 *
 * @param overrides - Partial data to return from each reader
 * @returns Readers stub
 */
function makeReaders(overrides: {
	focus?: string[];
	suppressed?: string[];
	insights?: string[];
	predictions?: Array<{ resolved: boolean }>;
	calibrationScore?: number;
	throws?: boolean;
} = {}): SelfModelReaders {
	const fail = async (): Promise<never> => {
		throw new Error('disk unavailable');
	};
	return {
		attention: {
			getAttention: overrides.throws
				? fail
				: async () => ({ focus: overrides.focus ?? [], suppressed: overrides.suppressed ?? [], lastPruned: '' }),
		},
		predictions: {
			getPredictions: async () => ({
				predictions: (overrides.predictions ?? []).map((p, i) => ({
					id: `pred-${i}`,
					prediction: `p${i}`,
					confidence: 0.5,
					madeAt: '2026-01-01',
					...(p.resolved ? { resolvedAt: '2026-01-02', accurate: true, outcome: 'ok' } : {}),
				})),
				calibrationScore: overrides.calibrationScore ?? 0,
			}),
		},
		consolidation: {
			getReport: async () => ({
				patterns: [],
				insights: (overrides.insights ?? []).map((insight) => ({ insight, confidence: 'high' as const, relatedMemories: [] })),
				consolidatedAt: '',
				memoriesAnalyzed: 0,
			}),
		},
	};
}

describe('MemoryReferenceModule', () => {
	let module: MemoryReferenceModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-dev-001',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/skills/agent',
		tlSkillsPath: '/skills/team-leader',
		projectRoot: '/project',
	};

	beforeEach(() => {
		module = new MemoryReferenceModule(makeReaders());
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('memory_references');
		expect(module.priority).toBe(4);
		expect(module.maxTokens).toBe(500);
		expect(module.compactable).toBe(false);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
	});

	it('should include memory routing rules table', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('## Memory Routing Rules');
		expect(result).toContain('scope: "project"');
		expect(result).toContain('scope: "agent"');
		expect(result).toContain('category: "pattern"');
		expect(result).toContain('category: "gotcha"');
	});

	it('should include rules of thumb', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Rules of thumb');
		expect(result).toContain('another agent');
		expect(result).toContain('future sessions');
	});

	it('should warn about secrets', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Never store secrets');
	});

	it('should match existing buildMemoryRoutingSection output', async () => {
		const result = await module.build(baseConfig);

		// Verify key phrases from the existing method are preserved
		expect(result).toContain('Team conventions, coding standards, project patterns, shared decisions');
		expect(result).toContain('User preferences, working style, role-specific tips');
		expect(result).toContain('Gotchas, bugs, workarounds discovered during work');
		expect(result).toContain('Temporary task notes, in-progress state, scratch data');
	});

	describe('self-model card', () => {
		it('is omitted entirely when the agent has no self-improvement data', async () => {
			const result = await module.build(baseConfig);
			expect(result).not.toContain('## Your Self-Model');
			expect(await module.buildSelfModelSection('crewly-dev-001')).toBe('');
		});

		it('renders focus, suppressed topics, insights and calibration with guidance', async () => {
			const m = new MemoryReferenceModule(
				makeReaders({
					focus: ['ship v2', 'flaky CI'],
					suppressed: ['legacy webhooks'],
					insights: ['testing: active learning area'],
					predictions: [{ resolved: true }, { resolved: true }, { resolved: false }],
					calibrationScore: 0.85,
				})
			);
			const result = await m.build(baseConfig);

			expect(result).toContain('## Memory Routing Rules');
			expect(result).toContain('## Your Self-Model');
			expect(result).toContain('- **Focus:** ship v2; flaky CI');
			expect(result).toContain('- **Ignore:** legacy webhooks');
			expect(result).toContain('- **Insights:** testing: active learning area');
			expect(result).toContain('- **Calibration:** 0.85 (2 resolved) — well calibrated');
		});

		it('caps focus/suppressed at 5 and insights at 3', async () => {
			const m = new MemoryReferenceModule(
				makeReaders({
					focus: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
					suppressed: ['s1', 's2', 's3', 's4', 's5', 's6'],
					insights: ['i1', 'i2', 'i3', 'i4'],
				})
			);
			const section = await m.buildSelfModelSection('x');
			expect(section).toContain('f5');
			expect(section).not.toContain('f6');
			expect(section).toContain('s5');
			expect(section).not.toContain('s6');
			expect(section).toContain('i3');
			expect(section).not.toContain('i4');
		});

		it('gives overconfidence guidance for a low calibration score and hedging for a middling one', async () => {
			const low = new MemoryReferenceModule(makeReaders({ predictions: [{ resolved: true }], calibrationScore: 0.3 }));
			expect(await low.buildSelfModelSection('x')).toContain('running ahead of your accuracy');

			const mid = new MemoryReferenceModule(makeReaders({ predictions: [{ resolved: true }], calibrationScore: 0.65 }));
			expect(await mid.buildSelfModelSection('x')).toContain('hedge when the evidence is thin');
		});

		it('does not report calibration when no prediction has been resolved', async () => {
			const m = new MemoryReferenceModule(
				makeReaders({ focus: ['a'], predictions: [{ resolved: false }], calibrationScore: 0 })
			);
			expect(await m.buildSelfModelSection('x')).not.toContain('Calibration');
		});

		it('is bounded to MAX_CHARS', async () => {
			const m = new MemoryReferenceModule(
				makeReaders({
					focus: Array.from({ length: 5 }, (_, i) => `focus item number ${i} ${'x'.repeat(80)}`),
					insights: Array.from({ length: 3 }, (_, i) => `insight ${i} ${'y'.repeat(200)}`),
				})
			);
			const section = await m.buildSelfModelSection('x');
			expect(section.length).toBeLessThanOrEqual(SELF_IMPROVEMENT_CONSTANTS.PROMPT.MAX_CHARS);
			expect(section.endsWith('…')).toBe(true);
		});

		it('swallows reader failures and still returns the routing rules', async () => {
			const m = new MemoryReferenceModule(makeReaders({ throws: true }));
			const result = await m.build(baseConfig);
			expect(result).toContain('## Memory Routing Rules');
			expect(result).not.toContain('## Your Self-Model');
		});

		it('constructs disk-backed readers by default', () => {
			expect(() => new MemoryReferenceModule()).not.toThrow();
		});
	});
});
