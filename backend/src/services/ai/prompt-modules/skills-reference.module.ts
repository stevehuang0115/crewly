import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Skills reference module — tells the agent how to discover and use skills.
 *
 * Consolidates skill references, role-based capability descriptions,
 * and catalog location into a single module. Capabilities are scoped
 * per-role to avoid blanket authorization (#225).
 *
 * Sources: Path A Step 1+6, Path B Section 8, Path C skill instructions.
 */
export class SkillsReferenceModule implements PromptModule {
	name = 'skills_references';
	priority = 5;
	maxTokens = 800;
	compactable = false;

	/**
	 * Always included — agents need to know how to use skills.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the skills reference section with catalog location,
	 * role-scoped capabilities, and memory tool instructions.
	 *
	 * @param config - Module configuration with skill paths and role
	 * @returns Formatted markdown skills reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const coreSkills = this.buildCoreSkills(config);
		const capabilities = this.buildCapabilities(config);
		const communication = this.buildCommunication(config);

		const safeCallGuide = this.buildSafeCallGuide(config);
		const connectors = this.buildConnectors(config);
		const parts = [coreSkills, capabilities, connectors, communication];
		if (safeCallGuide) {
			parts.push(safeCallGuide);
		}
		return parts.join('\n\n');
	}

	/**
	 * Build the connector skills section.
	 *
	 * These existed for weeks and no agent knew about them. The prompt
	 * described `remote-browser` at length as the way to reach anything
	 * behind the owner's login, and said nothing about Drive, Docs, Sheets,
	 * Slides, Gmail or Calendar — so an agent asked to read a Drive folder
	 * reasonably reached for the browser, found the Chrome extension
	 * disconnected, and reported that it could not do the job. The
	 * capability was installed and the account was connected the whole time.
	 *
	 * Hence the ordering note: for Google content the connector is the
	 * right tool and the browser is the fallback, not the other way round.
	 *
	 * @param config - Module configuration, for the skills path
	 * @returns The formatted section
	 */
	private buildConnectors(config: ModuleConfig): string {
		const p = `${config.agentSkillsPath}/core`;
		return [
			'## Connected accounts (Google Workspace)',
			'',
			'The owner can connect Google to Crewly. When they have, these skills read and',
			'write it directly through that grant — **no browser, no Chrome extension, no login**.',
			'',
			`- \`${p}/drive-search\` — find files in Drive by text, type or folder`,
			`- \`${p}/drive-read\` — read a Drive file's content`,
			`- \`${p}/drive-upload\` — put a file or text into Drive`,
			`- \`${p}/docs-read\` / \`docs-write\` — read a Google Doc as text; create one or append to it`,
			`- \`${p}/sheets-read\` / \`sheets-write\` — read a range as rows; create a sheet or append rows`,
			`- \`${p}/slides-read\` / \`slides-create\` — read a deck as text; build one from an outline`,
			`- \`${p}/gmail-search\` / \`gmail-read\` — search and read the owner's mail`,
			`- \`${p}/gmail-send\` — compose mail. It leaves a **draft**; only the owner sends it`,
			`- \`${p}/calendar-list\` / \`calendar-create\` — upcoming events; create one`,
			'',
			'**For anything in Google, reach for these first.** `remote-browser` is the fallback,',
			'not the default: it needs the Chrome extension connected, it is slower, and it acts',
			'inside a real logged-in browser where a stray click has real consequences.',
			'',
			`Not connected yet? The call returns \`{"success":false,"reason":"not_connected","hint":"<url>"}\`.`,
			`Do not report that as "I cannot do this" — run \`${p}/google-connect\` to ask the owner`,
			'to authorize it, tell them what you are waiting on, and stop there.',
			'',
			'Consent is per product, so an account connected for Calendar cannot read Drive.',
		].join('\n');
	}

	/**
	 * Build the core skills list — available to all roles.
	 */
	private buildCoreSkills(config: ModuleConfig): string {
		const lines = [
			'## Available Skills',
			'',
			`Bash skills at \`${config.agentSkillsPath}/\`:`,
			'- `core/recall` — retrieve relevant knowledge from memory',
			'- `core/remember` — store knowledge for future reference',
			'- `core/record-learning` — record learnings while working',
			'- `core/report-status` — report status to team leader or orchestrator',
			'',
			'### Self-improvement skills (attention + calibration)',
			'- `core/set-focus` — replace your focus list (up to 5 items are shown in your prompt)',
			'- `core/suppress-noise` — mark a topic as noise so it stops pulling your attention',
			'- `core/record-prediction` — record a falsifiable prediction with a 0-1 confidence',
			'- `core/resolve-prediction` — close a prediction with its outcome; updates your calibration score',
			'',
			'### Follow-up skills (ad-hoc timers and event watchers)',
			'- `core/schedule-followup` — schedule a future check-in that creates a WorkItem at time T',
			'    • one-shot: `--in-minutes N` or `--fire-at <ISO8601>`',
			'    • bounded recurring: `--cron "<expr>" --max-fires N`',
			'    • target yourself (default) or another agent via `--target`',
			'- `core/watch-for-event` — fire a WorkItem whenever an event occurs (e.g. `agent:idle`, `task:completed`)',
			'    • narrow with `--filter-session <session>` or `--filter-json \'{"...":"..."}\'`',
			'    • cap with `--max-fires` / `--max-idle-fires` so a flapping source does not loop forever',
			'- `core/cancel-followup` — cancel a trigger you created (`--id` or `--name`)',
			'- `core/list-my-followups` — list follow-ups owned by your team (audit before adding a new one)',
			'',
			'**Follow-up discipline (required):**',
			'1. Every follow-up must have a **finite end**. Use `maxFires` for recurring, or rely on the default `maxIdleFires=3` auto-cancel.',
			'2. Call `cancel-followup` the moment you confirm the task is done — do not rely on idle-auto-cancel as your only safety net.',
			'3. Before scheduling a new watcher on a target, run `list-my-followups --name-prefix watch:` to avoid duplicates.',
			'4. Prefer `watch-for-event` when you need reactive coverage (agent went idle → check). Prefer `schedule-followup` when you need a wall-clock checkpoint (9am tomorrow → re-prompt).',
		];

		// Orchestrators and TLs get additional coordination skills
		if (config.role === 'orchestrator') {
			lines.push(
				'- `core/send-message` — send messages to agents',
				'- `core/get-sops` — request relevant SOPs',
				'- Orchestrator skills at `config/skills/orchestrator/`:',
				'  - `schedule-check` — schedule future check-in reminders',
				'  - `subscribe-event` — subscribe to agent lifecycle events',
				'  - `reply-slack` / `reply-chat` — respond to user messages',
				'  - `reply-gchat` — respond to Google Chat messages',
				'  - `core/attach-file` — put a real file (PDF, image, sheet) into your Slack channel',
				'  - Colleagues on OTHER machines: talk to them in a shared Slack team channel (@ their name; `list-colleagues` shows who exists). The old `send-to-remote` / `reply-remote` / `list-devices` skills are deprecated — only answer a `[REMOTE:...]` message with `reply-remote`, never start one.',
				'  - `delegate-task` / `assign-task` — assign work to agents',
				'  - `get-team-status` / `get-agent-status` — monitor team state',
				'  - `create-team` / `update-team` / `start-team` / `stop-team` — team management',
				'  - `start-agent` / `stop-agent` / `terminate-agent` — agent lifecycle',
				'  - `create-cron` / `list-cron` / `update-cron` / `cancel-cron` — recurring tasks',
				'',
				'**IMPORTANT:** You have ALL skills listed above. Never say you lack a skill — if unsure, check the catalog.',
			);
		} else if (config.canDelegate) {
			lines.push(
				'- `core/send-message` — communicate with subordinates and orchestrator',
				'- `core/get-sops` — request relevant SOPs',
				`- Team leader skills at \`${config.tlSkillsPath}/\`:`,
				'  - `delegate-task` — assign tasks to subordinates',
				'  - `verify-output` — check completed work quality',
				'  - `schedule-check` — schedule follow-up reminders',
			);
		} else {
			lines.push(
				'- `core/send-message` — communicate with team leader',
				'- `core/get-sops` — request relevant SOPs for current situation',
			);
		}

		lines.push('', 'Skills catalog: `~/.crewly/skills/AGENT_SKILLS_CATALOG.md`');

		return lines.join('\n');
	}

	/**
	 * Build role-scoped capabilities section (#225).
	 * Workers get narrow read+execute scope; orchestrators get broader coordination scope.
	 */
	private buildCapabilities(config: ModuleConfig): string {
		const lines = ['## Available Capabilities', ''];

		if (config.role === 'orchestrator') {
			lines.push(
				'This session has access to:',
				'- **Read** project files for status awareness (not for implementation)',
				'- **Execute** orchestrator skill scripts for team coordination',
				'- **Execute** agent skill scripts (`core/` memory and status tools)',
				'- **Browser automation** via Playwright MCP server (when enabled)',
				'',
				'Implementation work (editing code, creating files) should be delegated to agents.',
			);
		} else if (config.canDelegate) {
			lines.push(
				'This session has access to:',
				`- **Read/Write** files within the project directory`,
				`- **Execute** bash scripts in \`${config.agentSkillsPath}/\` (agent core skills)`,
				`- **Execute** bash scripts in \`${config.tlSkillsPath}/\` (team leader skills)`,
				'- **Browser automation** via Playwright MCP server (when enabled)',
			);
		} else {
			lines.push(
				'This session has access to:',
				`- **Read/Write** files within the project directory`,
				`- **Execute** bash scripts in \`${config.agentSkillsPath}/\` (agent core skills)`,
				'- **Browser automation** via Playwright MCP server (when enabled)',
			);
		}

		// Crewly in Chrome clarification — prevents agents from confusing
		// the remote-browser skill with Playwright, Chrome DevTools, or computer-use.
		const remoteBrowserPath = `${config.agentSkillsPath}/remote-browser/execute.sh`;
		lines.push(
			'',
			'### Crewly in Chrome (remote-browser skill)',
			'',
			'"Crewly in Chrome" = the `remote-browser` skill. This is the ONLY way to control the user\'s real Chrome browser.',
			`- **Skill path:** \`${remoteBrowserPath}\``,
			'- **How it works:** Sends commands to the Crewly Chrome Extension installed in the user\'s real Chrome browser.',
			'  The Extension connects via direct WebSocket or Cloud Relay. The skill calls HTTP endpoints at `/api/browser/*`.',
			'- **Has the user\'s login sessions:** Because it controls the user\'s actual Chrome, it has access to all logged-in sites.',
			'- **NOT Playwright** — Playwright runs a headless/sandboxed browser with no user sessions.',
			'- **NOT Chrome DevTools / CDP** — This is a higher-level tool that works through the Chrome Extension.',
			'- **NOT computer-use** — computer-use controls the entire desktop; remote-browser only controls Chrome tabs.',
			'',
			'When asked to "use Chrome", "browse the web", or "check a website", use the `remote-browser` skill:',
			'```bash',
			`bash ${remoteBrowserPath} '{"action":"navigate","url":"https://example.com"}'`,
			`bash ${remoteBrowserPath} '{"action":"screenshot"}'`,
			`bash ${remoteBrowserPath} '{"action":"read-text"}'`,
			`bash ${remoteBrowserPath} '{"action":"status"}'`,
			'```',
		);

		return lines.join('\n');
	}

	/**
	 * Build safe skill calling guide for runtimes with shell escaping issues.
	 *
	 * Gemini CLI's run_shell_command mangles JSON arguments containing quotes,
	 * backticks, and parentheses, causing "unexpected EOF" shell errors.
	 * This guide instructs the agent to write JSON to a temp file using heredoc
	 * with a single-quoted delimiter, then pass --file <path>.
	 *
	 * Uses `<< 'CREWLY_EOF'` instead of `printf '%s' '...'` because:
	 * - Single-quoted heredoc delimiter prevents ALL shell interpretation
	 * - Single quotes, double quotes, backticks, $, () all pass through literally
	 * - The previous printf approach broke when JSON contained single quotes
	 *   (e.g., "it's working" or "don't forget")
	 *
	 * Only included for gemini-cli runtime type.
	 *
	 * @param config - Module configuration with runtime type
	 * @returns Safe calling guide markdown, or null if not needed
	 */
	private buildSafeCallGuide(config: ModuleConfig): string | null {
		if (config.runtimeType !== 'gemini-cli') {
			return null;
		}

		return `## Safe Skill Calling (MANDATORY)

**CRITICAL:** All skills support **CLI flags** — use them instead of JSON to avoid shell escaping issues.
Passing JSON as a shell argument causes "unexpected EOF" errors when content contains quotes, backticks, or parentheses.

### CLI Flags Pattern (ALWAYS use this)
\`\`\`bash
# report-status
bash ${config.agentSkillsPath}/core/report-status/execute.sh --session "my-agent" --status done --summary "Fixed the bug — it's working now" --project "${config.projectPath || config.projectRoot}"

# send-message
bash ${config.agentSkillsPath}/core/send-message/execute.sh --to "target-session" --message "Please implement feature X"

# remember
bash ${config.agentSkillsPath}/core/remember/execute.sh --agent "my-agent" --content "Key finding" --category pattern --scope project --project "${config.projectPath || config.projectRoot}"

# recall
bash ${config.agentSkillsPath}/core/recall/execute.sh --agent "my-agent" --context "topic to search" --project "${config.projectPath || config.projectRoot}"

# record-learning
bash ${config.agentSkillsPath}/core/record-learning/execute.sh --agent "my-agent" --role developer --project "${config.projectPath || config.projectRoot}" --learning "What I learned"
\`\`\`

### For long text (multi-line or special chars): use stdin or --summary-file/--message-file
\`\`\`bash
# Pipe long text via stdin
echo "Multi-line summary with 'quotes' and special chars" | bash ${config.agentSkillsPath}/core/report-status/execute.sh --session "my-agent" --status done --project "${config.projectPath || config.projectRoot}"

# Or write to file first, then use --summary-file
cat > /tmp/summary.txt << 'CREWLY_EOF'
Long summary with 'quotes', \`backticks\`, and (parens)
CREWLY_EOF
bash ${config.agentSkillsPath}/core/report-status/execute.sh --session "my-agent" --status done --summary-file /tmp/summary.txt --project "${config.projectPath || config.projectRoot}"
\`\`\`${config.canDelegate ? `

### Team Leader Skills
\`\`\`bash
# delegate-task
bash ${config.tlSkillsPath}/delegate-task/execute.sh --to "worker-session" --task "implement feature X" --priority high --project "${config.projectPath || config.projectRoot}" --team "${config.teamId || ''}" --tl-member "${config.memberId}"

# For long task descriptions, pipe via stdin:
echo "Detailed task description here" | bash ${config.tlSkillsPath}/delegate-task/execute.sh --to "worker-session" --priority high --project "${config.projectPath || config.projectRoot}"
\`\`\`` : ''}

### Rules
1. **ALWAYS** use CLI flags: \`--session\`, \`--status\`, \`--summary\`, \`--to\`, \`--message\`, etc.
2. **NEVER** pass JSON directly as a shell argument: \`bash execute.sh '{"key":"value"}'\`
3. For text with special characters, use **stdin pipe** or \`--summary-file\`/\`--message-file\`/\`--task-file\`
4. Legacy JSON is still supported via \`--file\` flag if needed, but CLI flags are preferred
5. Use \`--help\` on any skill to see all available flags`;
	}

	/**
	 * Build communication and memory tool instructions.
	 */
	private buildCommunication(config: ModuleConfig): string {
		return `## Communication

Use bash skills at \`${config.agentSkillsPath}/\` for all team communication. Read \`~/.crewly/skills/AGENT_SKILLS_CATALOG.md\` for a full reference.
- \`send-message\` to communicate with other agents
- \`report-progress\` to update on task status
- \`remember\` to store important learnings (always pass your \`agentId\` and \`projectPath\`)
- \`recall\` to retrieve relevant knowledge (always pass your \`agentId\` and \`projectPath\`)
- \`record-learning\` to record learnings (always pass your \`agentId\` and \`projectPath\`)
- \`get-sops\` to request relevant SOPs for your current situation
- \`core/attach-file\` to put a real file into the Slack channel you are replying in

**When someone asks for a file, send the file.** \`reply-channel\` carries text
only, so use \`core/attach-file --channel <the id from your prompt> --path <file>\`;
it lands in the same thread, under your own name. Uploading to Drive and pasting
a link is not the same thing — it makes them leave Slack, it breaks for anyone
without access to that Drive, and on a phone it is several taps to something they
wanted in front of them. Attach the file; add a link too only if they will want
to edit it.

**IMPORTANT for memory tools:** When calling \`remember\`, \`recall\`, or \`record-learning\`, you MUST pass:
- \`agentId\`: Your **Session Name** from the Identity section above
- \`projectPath\`: Your **Project Path** from the Identity section above
This ensures your knowledge is stored under your identity and in the correct project.

**IMPORTANT for recall:** Before answering questions about the project, deployment, architecture, or past decisions, ALWAYS call \`recall\` first to check your stored knowledge.`;
	}
}
