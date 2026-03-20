import { TeamReferenceModule } from './team-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

// Mock fs/promises
jest.mock('fs/promises', () => ({
	readFile: jest.fn(),
	access: jest.fn(),
}));

// Mock fs (sync)
jest.mock('fs', () => ({
	existsSync: jest.fn().mockReturnValue(false),
	readdirSync: jest.fn().mockReturnValue([]),
	readFileSync: jest.fn().mockReturnValue(''),
}));

import { readFile, access } from 'fs/promises';

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockAccess = access as jest.MockedFunction<typeof access>;

describe('TeamReferenceModule', () => {
	let module: TeamReferenceModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-tl-001',
		memberId: 'tl-member-001',
		role: 'developer',
		teamId: 'team-001',
		projectPath: '/project',
		canDelegate: true,
		subordinates: [
			{ name: 'Leo', sessionName: 'crewly-dev-leo', role: 'developer', memberId: 'leo-001' },
			{ name: 'Max', sessionName: 'crewly-dev-max', role: 'developer', memberId: 'max-001' },
		],
		agentSkillsPath: '/skills/agent',
		tlSkillsPath: '/skills/team-leader',
		projectRoot: '/project-root',
	};

	beforeEach(() => {
		module = new TeamReferenceModule();
		jest.clearAllMocks();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('team_references');
		expect(module.priority).toBe(6);
		expect(module.maxTokens).toBe(8000);
		expect(module.compactable).toBe(false);
	});

	it('should include when agent has a team', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
	});

	it('should include when agent has subordinates', () => {
		const config = { ...baseConfig, teamId: undefined };
		expect(module.shouldInclude(config)).toBe(true);
	});

	it('should not include when no team and no subordinates', () => {
		const config = {
			...baseConfig,
			teamId: undefined,
			canDelegate: false,
			subordinates: undefined,
		};
		expect(module.shouldInclude(config)).toBe(false);
	});

	it('should build inline TL section when addon file not found', async () => {
		mockAccess.mockRejectedValue(new Error('ENOENT'));

		const result = await module.build(baseConfig);

		expect(result).toContain('Team Lead Responsibilities');
		expect(result).toContain('Leo');
		expect(result).toContain('Max');
		expect(result).toContain('crewly-dev-leo');
		expect(result).toContain('crewly-dev-max');
	});

	it('should load TL addon from file and resolve variables', async () => {
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockResolvedValue(
			'# TL Addon\n\n## Workers\n{{WORKER_LIST}}\n\nTeam: {{TEAM_ID}}\nPath: {{PROJECT_PATH}}\nSkills: {{AGENT_SKILLS_PATH}}' as unknown as Buffer
		);

		const result = await module.build(baseConfig);

		expect(result).toContain('# TL Addon');
		expect(result).toContain('Leo');
		expect(result).toContain('team-001');
		expect(result).toContain('/project');
		expect(result).toContain('/skills/agent');
		expect(result).not.toContain('{{WORKER_LIST}}');
		expect(result).not.toContain('{{TEAM_ID}}');
	});

	it('should not include TL section when canDelegate is false', async () => {
		const config = { ...baseConfig, canDelegate: false, subordinates: [] };
		const result = await module.build(config);

		expect(result).not.toContain('Team Lead');
	});

	it('should format worker list correctly', async () => {
		mockAccess.mockRejectedValue(new Error('ENOENT'));

		const result = await module.build(baseConfig);

		expect(result).toContain('- **Leo** (session: `crewly-dev-leo`, memberId: `leo-001`) — developer');
		expect(result).toContain('- **Max** (session: `crewly-dev-max`, memberId: `max-001`) — developer');
	});
});
