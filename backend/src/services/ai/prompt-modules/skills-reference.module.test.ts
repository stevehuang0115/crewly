import { SkillsReferenceModule } from './skills-reference.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

describe('SkillsReferenceModule', () => {
	let module: SkillsReferenceModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-dev-001',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new SkillsReferenceModule();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('skills_references');
		expect(module.priority).toBe(5);
		expect(module.maxTokens).toBe(800);
		expect(module.compactable).toBe(false);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
	});

	it('should include skill paths in output', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('/path/to/skills/agent/');
	});

	it('should reference core skills for all roles', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('core/recall');
		expect(result).toContain('core/remember');
		expect(result).toContain('core/record-learning');
		expect(result).toContain('core/report-status');
		expect(result).toContain('core/set-focus');
		expect(result).toContain('core/suppress-noise');
		expect(result).toContain('core/record-prediction');
		expect(result).toContain('core/resolve-prediction');
	});

	it('should include skill catalog reference', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('AGENT_SKILLS_CATALOG.md');
	});

	it('should include capabilities section', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('Available Capabilities');
		expect(result).toContain('Playwright MCP server');
	});

	it('should include memory tool instructions', async () => {
		const result = await module.build(baseConfig);

		expect(result).toContain('agentId');
		expect(result).toContain('projectPath');
		expect(result).toContain('IMPORTANT for memory tools');
	});

	describe('role-based capabilities (#225)', () => {
		it('should give workers narrow scope (no TL skills path)', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('Read/Write');
			expect(result).toContain('agent core skills');
			expect(result).not.toContain('team leader skills');
			expect(result).not.toContain('orchestrator skill');
			expect(result).not.toContain('delegate-task');
		});

		it('should give orchestrators coordination scope', async () => {
			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('orchestrator skill scripts');
			expect(result).toContain('schedule-check');
			expect(result).toContain('subscribe-event');
			expect(result).toContain('reply-slack');
			expect(result).toContain('delegate-task');
			expect(result).toContain('delegated to agents');
			// Cross-machine collaboration goes through Slack; the Cloud-queue skills are legacy.
			expect(result).toContain('shared Slack team channel');
			expect(result).toContain('list-colleagues');
			expect(result).toContain('deprecated');
		});

		it('should give TLs delegation scope', async () => {
			const tlConfig: ModuleConfig = { ...baseConfig, role: 'team-leader', canDelegate: true };
			const result = await module.build(tlConfig);

			expect(result).toContain('team leader skills');
			expect(result).toContain('delegate-task');
			expect(result).toContain('verify-output');
			expect(result).toContain('schedule-check');
			expect(result).toContain(baseConfig.tlSkillsPath);
		});

		it('should not include blanket authorization language', async () => {
			for (const role of ['developer', 'orchestrator']) {
				const config: ModuleConfig = { ...baseConfig, role };
				const result = await module.build(config);

				expect(result).not.toContain('pre-approved');
				expect(result).not.toContain('Authorized Operations');
				expect(result).not.toContain('authorized to');
				expect(result).not.toContain('adopt');
			}
		});

		it('should distinguish read vs write for orchestrator', async () => {
			const orchConfig: ModuleConfig = { ...baseConfig, role: 'orchestrator' };
			const result = await module.build(orchConfig);

			expect(result).toContain('**Read** project files');
			expect(result).not.toContain('Read/Write');
		});
	});

	describe('sending files', () => {
		it('names attach-file, which no agent could previously discover', async () => {
			// reply-channel carries text only, so an agent asked for a PDF
			// uploaded it to Drive and pasted a link — then correctly said the
			// interface it had been told to use could not send attachments.
			const out = await module.build(baseConfig);
			expect(out).toContain('attach-file');
		});

		it('says to send the file rather than a link to it', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/When someone asks for a file, send the file/i);
			expect(out).toMatch(/pasting\s+\na?\s*link is not the same thing|a link is not the same thing/i);
		});

		it('gives the reasons, so it is a judgement and not a rule to route around', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/makes them leave\s+Slack/i);
			expect(out).toMatch(/without access to that Drive/i);
		});

		it('tells the agent which channel id to pass, and not to ask for a Slack one', async () => {
			// It has a chat channel id, not a Slack one. Asked for a PDF, an
			// agent offered to attach it "if you give me the Slack channel ID"
			// — a question the owner should never be asked.
			const out = await module.build(baseConfig);
			expect(out).toMatch(/--channel <the id from your prompt>/);
			expect(out).toMatch(/not\*{0,2}\s+need a Slack channel id/i);
		});

		it('covers both reply paths, since the agent cannot tell which it is on', async () => {
			// A DM routes through reply-chat and a team channel through
			// reply-channel; naming only one leaves the other case unaddressed,
			// and the DM is the case that actually came up.
			const out = await module.build(baseConfig);
			expect(out).toContain('reply-chat');
			expect(out).toContain('reply-channel');
			expect(out).toMatch(/team channel or a\s*\n?\s*one-to-one DM/i);
		});

		it('is shown to every role', async () => {
			for (const role of ['orchestrator', 'team-leader', 'qa', 'developer']) {
				const out = await module.build({ ...baseConfig, role });
				expect(out).toContain('attach-file');
			}
		});
	});

	describe('connected accounts (Google Workspace)', () => {
		it('names the Drive skills, which no agent could previously discover', async () => {
			// These shipped weeks ago and the prompt never mentioned them, so an
			// agent asked to read a Drive folder reached for the browser, found
			// the extension disconnected, and reported it could not do the job —
			// with the capability installed and the account connected.
			const out = await module.build(baseConfig);

			expect(out).toContain('drive-search');
			expect(out).toContain('drive-read');
			expect(out).toContain('drive-upload');
		});

		it('names every connector family, not just Drive', async () => {
			const out = await module.build(baseConfig);

			for (const skill of ['docs-read', 'sheets-read', 'slides-read', 'gmail-search', 'calendar-list']) {
				expect(out).toContain(skill);
			}
		});

		it('says these come first and the browser is the fallback', async () => {
			// The ordering is the whole point: the prompt described
			// remote-browser at length and these not at all, so the browser won
			// by default for anything behind a login.
			const out = await module.build(baseConfig);

			expect(out).toMatch(/reach for these first/i);
			expect(out).toMatch(/fallback/i);
		});

		it('tells the agent what to do when the account is not connected', async () => {
			// Otherwise "not_connected" gets reported to the owner as an
			// incapability, which is what it looks like from the inside.
			const out = await module.build(baseConfig);

			expect(out).toContain('not_connected');
			expect(out).toContain('google-connect');
			expect(out).toMatch(/Do not report that as/i);
		});

		it('is honest that gmail-send only drafts', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/draft/i);
			expect(out).toMatch(/only the owner sends it/i);
		});

		it('warns that consent is per product', async () => {
			const out = await module.build(baseConfig);
			expect(out).toMatch(/per product/i);
		});

		it('shows them to every role, not just developers', async () => {
			for (const role of ['orchestrator', 'team-leader', 'qa']) {
				const out = await module.build({ ...baseConfig, role });
				expect(out).toContain('drive-search');
			}
		});
	});

	describe('Crewly in Chrome documentation', () => {
		it('should include remote-browser skill documentation for all roles', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('Crewly in Chrome');
			expect(result).toContain('remote-browser');
			expect(result).toContain('NOT Playwright');
			expect(result).toContain('NOT Chrome DevTools');
			expect(result).toContain('NOT computer-use');
			expect(result).toContain(`${baseConfig.agentSkillsPath}/remote-browser/execute.sh`);
		});

		it('should include usage examples', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('"action":"navigate"');
			expect(result).toContain('"action":"screenshot"');
			expect(result).toContain('"action":"status"');
		});

		it('should mention Chrome Extension and Cloud Relay', async () => {
			const result = await module.build(baseConfig);

			expect(result).toContain('Chrome Extension');
			expect(result).toContain('Cloud Relay');
		});
	});

	describe('safe skill calling guide (#EOF-fix)', () => {
		it('should include CLI flags guide for gemini-cli runtime', async () => {
			const geminiConfig: ModuleConfig = { ...baseConfig, runtimeType: 'gemini-cli' };
			const result = await module.build(geminiConfig);

			expect(result).toContain('Safe Skill Calling');
			expect(result).toContain('CLI flags');
			expect(result).toContain('NEVER');
			// Should show CLI flag examples
			expect(result).toContain('--session');
			expect(result).toContain('--status');
			expect(result).toContain('--summary');
			expect(result).toContain('--agent');
			expect(result).toContain('--content');
			expect(result).toContain('--category');
		});

		it('should include stdin pipe pattern for long text', async () => {
			const geminiConfig: ModuleConfig = { ...baseConfig, runtimeType: 'gemini-cli' };
			const result = await module.build(geminiConfig);

			expect(result).toContain('stdin');
			expect(result).toContain('--summary-file');
		});

		it('should NOT include guide for claude-code runtime', async () => {
			const claudeConfig: ModuleConfig = { ...baseConfig, runtimeType: 'claude-code' };
			const result = await module.build(claudeConfig);

			expect(result).not.toContain('Safe Skill Calling');
		});

		it('should NOT include guide when runtimeType is not set', async () => {
			const result = await module.build(baseConfig);

			expect(result).not.toContain('Safe Skill Calling');
		});

		it('should reference the agent skills path in examples', async () => {
			const geminiConfig: ModuleConfig = { ...baseConfig, runtimeType: 'gemini-cli' };
			const result = await module.build(geminiConfig);

			expect(result).toContain(baseConfig.agentSkillsPath);
			expect(result).toContain('report-status');
		});

		it('should include TL skills CLI flags example for gemini-cli TLs', async () => {
			const geminiTLConfig: ModuleConfig = { ...baseConfig, runtimeType: 'gemini-cli', canDelegate: true };
			const result = await module.build(geminiTLConfig);

			expect(result).toContain('Team Leader Skills');
			expect(result).toContain(`${baseConfig.tlSkillsPath}/delegate-task/execute.sh --to`);
		});

		it('should NOT include TL skills example for non-TL gemini agents', async () => {
			const geminiConfig: ModuleConfig = { ...baseConfig, runtimeType: 'gemini-cli' };
			const result = await module.build(geminiConfig);

			expect(result).not.toContain('Team Leader Skills');
		});

		it('should include --help instruction in rules', async () => {
			const geminiConfig: ModuleConfig = { ...baseConfig, runtimeType: 'gemini-cli' };
			const result = await module.build(geminiConfig);

			expect(result).toContain('--help');
		});
	});
});
