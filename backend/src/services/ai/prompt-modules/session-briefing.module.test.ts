import { SessionBriefingModule } from './session-briefing.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('SessionBriefingModule (#816)', () => {
	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-leo-21a5477e',
		memberId: '21a5477e',
		role: 'developer',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};
	const BRIEFING = '## Your Previous Knowledge\n\n### Last Session\nRebased PR #30';

	let module: SessionBriefingModule;
	beforeEach(() => {
		module = new SessionBriefingModule();
	});

	it('sits after Active Work and before recovery, and may be trimmed', () => {
		expect(module.name).toBe('session-briefing');
		expect(module.priority).toBeGreaterThan(1.5);
		expect(module.priority).toBeLessThan(2);
		expect(module.compactable).toBe(true);
	});

	it.each([undefined, '', '  \n '])('is skipped when the briefing is %p', (briefing) => {
		expect(module.shouldInclude({ ...baseConfig, sessionBriefing: briefing })).toBe(false);
	});

	it('is included and rendered verbatim when a briefing is provided', async () => {
		const config = { ...baseConfig, sessionBriefing: `\n${BRIEFING}\n` };
		expect(module.shouldInclude(config)).toBe(true);
		expect(await module.build(config)).toBe(BRIEFING);
	});

	it('builds an empty string when asked without a briefing', async () => {
		expect(await module.build(baseConfig)).toBe('');
	});
});
