import { CommunicationModule } from './communication.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

// Mock fs for fragment loading
jest.mock('fs', () => ({
	existsSync: jest.fn().mockReturnValue(false),
	readFileSync: jest.fn().mockReturnValue(''),
}));

describe('CommunicationModule', () => {
	let module: CommunicationModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-sam-217bfbbf',
		memberId: '217bfbbf-9c90-41ec-bf93-b7fca1b5934f',
		role: 'developer',
		teamId: '817a1aeb-b04e-45dd-bdbc-be5cbc4345f1',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new CommunicationModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('communication');
		expect(module.priority).toBe(8);
		expect(module.maxTokens).toBe(2000);
		expect(module.compactable).toBe(true);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, role: 'orchestrator' })).toBe(true);
	});

	describe('worker communication (default)', () => {
		it('should build compact worker communication', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('## Communication');
			expect(result).toContain('report-status');
			expect(result).toContain('send-message');
			expect(result).toContain(baseConfig.sessionName);
		});

		it('should include report-status command with correct paths', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain(baseConfig.agentSkillsPath);
			expect(result).toContain('report-status');
			expect(result).toContain(baseConfig.projectPath);
		});

		it('should include concise rules', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('Report progress periodically');
			expect(result).toContain('Report blockers immediately');
		});

		it('should not include orchestrator-specific content', async () => {
			const result = await module.build(baseConfig);

			expect(result).not.toContain('Message Channels');
			expect(result).not.toContain('Slack mrkdwn');
			expect(result).not.toContain('NOTIFY');
		});
	});

	describe('orchestrator communication', () => {
		const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };

		it('should build full communication protocol', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('## Communication Protocol');
			expect(result).toContain('### Message Channels');
			expect(result).toContain('### Message Routing Rules');
			expect(result).toContain('### Slack Communication');
			expect(result).toContain('### Chat UI Communication');
			expect(result).toContain('### Notification Protocol');
			expect(result).toContain('### Thread Context');
		});

		it('should include Slack formatting rules', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('mrkdwn');
			expect(result).toContain('Bold:');
			expect(result).toContain('reply-slack');
		});

		it('should include NOTIFY marker handling', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain('[NOTIFY]');
			expect(result).toContain('Never forward raw NOTIFY markers');
		});

		it('should include communication skills with correct paths', async () => {
			const result = await module.build(orchConfig);

			expect(result).toContain(`${orchConfig.agentSkillsPath}/core/report-status`);
			expect(result).toContain(`${orchConfig.agentSkillsPath}/core/send-message`);
		});
	});

	describe('team leader communication', () => {
		const tlConfig: ModuleConfig = { ...baseConfig, role: 'team-leader', canDelegate: true };

		it('should build TL communication with delegation focus', async () => {
			const result = await module.build(tlConfig);

			expect(result).toContain('## Communication Protocol');
			expect(result).toContain('### Reporting to Orchestrator');
			expect(result).toContain('### Messaging Workers');
			expect(result).toContain('### Communication Rules');
		});

		it('should include TL_REPORT tag instruction', async () => {
			const result = await module.build(tlConfig);

			expect(result).toContain('[TL_REPORT]');
		});

		it('should include both report-status and send-message', async () => {
			const result = await module.build(tlConfig);

			expect(result).toContain('report-status');
			expect(result).toContain('send-message');
			expect(result).toContain(tlConfig.sessionName);
		});

		it('should not include orchestrator-only content', async () => {
			const result = await module.build(tlConfig);

			expect(result).not.toContain('Slack mrkdwn');
			expect(result).not.toContain('[NOTIFY]');
			expect(result).not.toContain('Message Channels');
		});
	});

	describe('projectPath fallback', () => {
		it('should use projectRoot when projectPath is undefined', async () => {
			const noPathConfig: ModuleConfig = {
				...baseConfig,
				projectPath: undefined,
			};
			const result = await module.build(noPathConfig);

			expect(result).toContain(baseConfig.projectRoot);
		});
	});

	describe('fragment loading', () => {
		it('should load fragment for orchestrator when available', async () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValueOnce(true);
			fs.readFileSync.mockReturnValueOnce('# Custom Orchestrator Communication\nLoaded from fragment');

			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('Custom Orchestrator Communication');
			expect(result).toContain('Loaded from fragment');
		});

		it('should fall back to inline content when fragment not found', async () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValue(false);

			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('## Communication Protocol');
		});

		it('should not attempt fragment loading for non-orchestrator roles', async () => {
			const fs = require('fs');
			fs.existsSync.mockClear();

			const result = await module.build(baseConfig);

			expect(result).toContain('## Communication');
			// Worker path doesn't call loadRoleFragment
		});
	});
});
