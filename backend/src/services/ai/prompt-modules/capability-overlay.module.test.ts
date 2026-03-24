import { CapabilityOverlayModule } from './capability-overlay.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('CapabilityOverlayModule', () => {
	let module: CapabilityOverlayModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'test-session',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/skills',
		tlSkillsPath: '/tl-skills',
		projectRoot: '/tmp/nonexistent-test-path',
	};

	beforeEach(() => {
		module = new CapabilityOverlayModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('capability-overlay');
		expect(module.priority).toBe(7);
		expect(module.maxTokens).toBe(600);
		expect(module.compactable).toBe(true);
	});

	it('should not include when autonomyLevel is undefined and no capabilities', () => {
		expect(module.shouldInclude(baseConfig)).toBe(false);
	});

	it('should not include when autonomyLevel is directed and no capabilities', () => {
		expect(module.shouldInclude({ ...baseConfig, autonomyLevel: 'directed' })).toBe(false);
	});

	it('should include when autonomyLevel is bounded', () => {
		expect(module.shouldInclude({ ...baseConfig, autonomyLevel: 'bounded' })).toBe(true);
	});

	it('should include when autonomyLevel is domain_autonomous', () => {
		expect(module.shouldInclude({ ...baseConfig, autonomyLevel: 'domain_autonomous' })).toBe(true);
	});

	it('should include when capabilities has entries even if autonomyLevel is directed', () => {
		expect(module.shouldInclude({
			...baseConfig,
			autonomyLevel: 'directed',
			capabilities: ['can-verify'],
		})).toBe(true);
	});

	it('should produce Bounded Autonomy content for bounded level', async () => {
		const result = await module.build({ ...baseConfig, autonomyLevel: 'bounded' });

		expect(result).toContain('## Capability Overlay');
		expect(result).toContain('### Decision Rights: Bounded Autonomy');
		expect(result).toContain('Make decisions within your assigned task and domain scope');
		expect(result).toContain('Log your reasoning for every non-trivial decision');
		expect(result).toContain('Escalate when risk or ambiguity exceeds your domain boundaries');
		expect(result).toContain('You may NOT: auto-deploy, modify production, or communicate directly with users');
	});

	it('should produce Domain Autonomous content for domain_autonomous level', async () => {
		const result = await module.build({ ...baseConfig, autonomyLevel: 'domain_autonomous' });

		expect(result).toContain('## Capability Overlay');
		expect(result).toContain('### Decision Rights: Domain Autonomous');
		expect(result).toContain('Monitor your domain continuously');
		expect(result).toContain('Make pre-approved decisions within your domain without waiting for delegation');
		expect(result).toContain('Log reasoning AND outcome for every autonomous decision');
		expect(result).toContain('You may NOT: take actions outside your domain SOP, skip logging, ignore risk policy');
	});

	it('should include capability overlay heading with fallback for missing files', async () => {
		const result = await module.build({
			...baseConfig,
			autonomyLevel: 'bounded',
			capabilities: ['can-verify', 'can-decide'],
		});

		expect(result).toContain('### Capability Overlays');
		expect(result).toContain('- **can-verify**: (no overlay file found)');
		expect(result).toContain('- **can-decide**: (no overlay file found)');
	});
});
