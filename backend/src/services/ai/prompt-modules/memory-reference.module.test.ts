import { MemoryReferenceModule } from './memory-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

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
		module = new MemoryReferenceModule();
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
});
