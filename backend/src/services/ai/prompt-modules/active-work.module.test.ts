import { ActiveWorkModule, ACTIVE_WORK_HEADING, renderActiveWorkSection } from './active-work.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('ActiveWorkModule (#816)', () => {
	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-leo-21a5477e',
		memberId: '21a5477e',
		role: 'developer',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};
	const BRIEFING = `${ACTIVE_WORK_HEADING}\n\n### Active WorkItems\n- **wi-1** — Fix it — _running · 1h_`;

	let module: ActiveWorkModule;
	beforeEach(() => {
		module = new ActiveWorkModule();
	});

	it('sits before the recovery protocol (priority 2) and is never trimmed', () => {
		expect(module.name).toBe('active-work');
		expect(module.priority).toBeLessThan(2);
		expect(module.compactable).toBe(false);
	});

	it('is always included, with or without a briefing', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, activeWorkBriefing: BRIEFING })).toBe(true);
	});

	it('renders the provided briefing verbatim', async () => {
		expect(await module.build({ ...baseConfig, activeWorkBriefing: `\n${BRIEFING}\n` })).toBe(BRIEFING);
	});

	it('keeps the empty-state briefing as-is ("fresh start" is a real answer)', async () => {
		const empty = `${ACTIVE_WORK_HEADING}\n\n(No active work — fresh start)`;
		expect(await module.build({ ...baseConfig, activeWorkBriefing: empty })).toBe(empty);
	});

	it('adds the heading when a briefing arrives without it', async () => {
		const result = await module.build({ ...baseConfig, activeWorkBriefing: '- **wi-2** — x' });
		expect(result.startsWith(`${ACTIVE_WORK_HEADING}\n\n`)).toBe(true);
		expect(result).toContain('wi-2');
	});

	it.each([undefined, '', '   \n'])('emits a "not injected" notice with the fetch command when the briefing is %p', async (briefing) => {
		const result = await module.build({ ...baseConfig, activeWorkBriefing: briefing });
		expect(result.startsWith(ACTIVE_WORK_HEADING)).toBe(true);
		expect(result).toContain('Not injected into this prompt');
		expect(result).toContain('does NOT mean you have no work');
		expect(result).toContain(
			'bash /path/to/skills/agent/core/get-my-active-work/execute.sh --session crewly-product-leo-21a5477e --role developer',
		);
	});

	it('renderActiveWorkSection matches the module output (shared by the legacy path)', async () => {
		const agent = { agentSkillsPath: baseConfig.agentSkillsPath, sessionName: baseConfig.sessionName, role: baseConfig.role };
		expect(renderActiveWorkSection(BRIEFING, agent)).toBe(await module.build({ ...baseConfig, activeWorkBriefing: BRIEFING }));
		expect(renderActiveWorkSection(undefined, agent)).toBe(await module.build(baseConfig));
	});
});
