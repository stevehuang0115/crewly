import { RiskPolicyModule } from './risk-policy.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('RiskPolicyModule', () => {
	let module: RiskPolicyModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'test-session',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/skills',
		tlSkillsPath: '/tl-skills',
		projectRoot: '/tmp/nonexistent-test-path',
	};

	beforeEach(() => {
		module = new RiskPolicyModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('risk-policy');
		expect(module.priority).toBe(10);
		expect(module.maxTokens).toBe(800);
		expect(module.compactable).toBe(true);
	});

	it('should not include when riskPolicy is undefined', () => {
		expect(module.shouldInclude(baseConfig)).toBe(false);
	});

	it('should include when riskPolicy is set', () => {
		expect(module.shouldInclude({ ...baseConfig, riskPolicy: 'production-deploy' })).toBe(true);
	});

	it('should return fallback message when policy file does not exist', async () => {
		const result = await module.build({ ...baseConfig, riskPolicy: 'missing-policy' });

		expect(result).toContain('## Risk Policy: missing-policy');
		expect(result).toContain('Policy file not found');
		expect(result).toContain('missing-policy.policy.md');
	});

	it('should include riskPolicy name in heading', async () => {
		const result = await module.build({ ...baseConfig, riskPolicy: 'data-migration' });

		expect(result).toContain('## Risk Policy: data-migration');
	});
});
