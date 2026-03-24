import { DomainSOPModule } from './domain-sop.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('DomainSOPModule', () => {
	let module: DomainSOPModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'test-session',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/skills',
		tlSkillsPath: '/tl-skills',
		projectRoot: '/tmp/nonexistent-test-path',
	};

	beforeEach(() => {
		module = new DomainSOPModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('domain-sop');
		expect(module.priority).toBe(9);
		expect(module.maxTokens).toBe(800);
		expect(module.compactable).toBe(true);
	});

	it('should not include when domainSOP is undefined', () => {
		expect(module.shouldInclude(baseConfig)).toBe(false);
	});

	it('should include when domainSOP is set', () => {
		expect(module.shouldInclude({ ...baseConfig, domainSOP: 'backend-dev' })).toBe(true);
	});

	it('should return fallback message when SOP file does not exist', async () => {
		const result = await module.build({ ...baseConfig, domainSOP: 'missing-sop' });

		expect(result).toContain('## Domain SOP: missing-sop');
		expect(result).toContain('SOP file not found');
		expect(result).toContain('missing-sop.sop.md');
	});

	it('should include domainSOP name in heading', async () => {
		const result = await module.build({ ...baseConfig, domainSOP: 'frontend-review' });

		expect(result).toContain('## Domain SOP: frontend-review');
	});
});
