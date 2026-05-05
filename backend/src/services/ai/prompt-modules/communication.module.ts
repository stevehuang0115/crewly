import * as path from 'path';
import { PromptModule, ModuleConfig, loadRoleFragment } from './prompt-module.interface.js';

/**
 * Communication module — defines how agents communicate across channels.
 *
 * Consolidates message routing (Slack, Chat UI, NOTIFY markers),
 * reply formatting, notification protocol, and thread-aware messaging
 * into a single module. Orchestrators get the full communication spec;
 * workers get a compact report-status-only version.
 *
 * Sources: orchestrator prompt.md §Chat & Slack Communication,
 *          §Notification Protocol, §Markdown Content, §Communication Channels,
 *          tool-registry reply_slack.
 */
export class CommunicationModule implements PromptModule {
	name = 'communication';
	priority = 8;
	maxTokens = 2000;
	compactable = true;

	/**
	 * Always included — every agent communicates.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the communication section.
	 * Orchestrators and TLs get full Slack/Chat/NOTIFY instructions.
	 * Workers get a compact version focused on report-status and send-message.
	 *
	 * @param config - Module configuration with agent details
	 * @returns Formatted markdown communication section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const isOrchestrator = config.role === 'orchestrator';
		const isTL = config.canDelegate === true;

		// Try loading role-specific fragment (orchestrator has the richest version).
		// Per piece #2 dispatch (4-piece skill-mistake fix, post-PR #446 merge):
		// the orc fragment now references {{ORCHESTRATOR_SKILLS_PATH}} and
		// {{AGENT_SKILLS_PATH}} placeholders that must be substituted to absolute
		// paths before the orc sees the prompt. loadRoleFragment returns the file
		// content as-is — substitution happens here so the orc-namespace gate
		// table renders with real paths.
		if (isOrchestrator) {
			const fragment = loadRoleFragment(config.projectRoot, config.role, 'communication');
			if (fragment) {
				const orchestratorSkillsPath = path.join(config.projectRoot, 'config', 'skills', 'orchestrator');
				return fragment
					.replace(/\{\{ORCHESTRATOR_SKILLS_PATH\}\}/g, orchestratorSkillsPath)
					.replace(/\{\{AGENT_SKILLS_PATH\}\}/g, config.agentSkillsPath);
			}
			return this.buildOrchestratorComms(config);
		}
		if (isTL) {
			return this.buildTLComms(config);
		}
		return this.buildWorkerComms(config);
	}

	/**
	 * Build a skill call example snippet. For gemini-cli runtime, uses CLI flags
	 * to avoid shell escaping EOF errors entirely. For other runtimes, uses
	 * inline JSON argument.
	 *
	 * CLI flags approach eliminates ALL quoting issues — each flag value is a
	 * simple double-quoted string, no JSON nesting, no single-quote matching.
	 *
	 * @param config - Module configuration with runtime type
	 * @param skillPath - Relative path to the skill (e.g., 'core/report-status')
	 * @param jsonExample - Example JSON string for inline mode (non-gemini)
	 * @param cliExample - Optional CLI flags example for gemini-cli mode
	 * @param basePath - Optional base path override (defaults to config.agentSkillsPath).
	 *                   Use config.tlSkillsPath for team-leader skills like delegate-task.
	 * @returns Formatted bash code block
	 */
	private buildSkillExample(config: ModuleConfig, skillPath: string, jsonExample: string, cliExample?: string, basePath?: string): string {
		const resolvedBase = basePath || config.agentSkillsPath;
		if (config.runtimeType === 'gemini-cli' && cliExample) {
			return `\`\`\`bash
bash ${resolvedBase}/${skillPath}/execute.sh ${cliExample}
\`\`\``;
		}
		if (config.runtimeType === 'gemini-cli') {
			// Fallback: heredoc for skills without CLI examples yet
			return `\`\`\`bash
cat > /tmp/crewly_skill_input.json << 'CREWLY_EOF'
${jsonExample}
CREWLY_EOF
bash ${resolvedBase}/${skillPath}/execute.sh --file /tmp/crewly_skill_input.json
\`\`\``;
		}
		return `\`\`\`bash
bash ${resolvedBase}/${skillPath}/execute.sh '${jsonExample}'
\`\`\``;
	}

	/**
	 * Full orchestrator communication spec — Slack, Chat UI, NOTIFY markers,
	 * thread management, message formatting, and notification protocol.
	 *
	 * Per orc-namespace convention (skill SKILL.md frontmatter excludes
	 * orchestrator from `assignableRoles` on send-message + recall + etc.):
	 * orc has its own send-message wrapper at `config/skills/orchestrator/send-message/`
	 * that routes through `/terminal/{session}/deliver` (readiness-aware,
	 * two-step delivery, retry) instead of the agent-side
	 * `/terminal/{session}/write` (raw PTY buffer write, no readiness, no
	 * Enter semantics). Rendering the agent-skills path here would let orc
	 * fall back to `/write` and miss orc-specific routing — the exact
	 * "ORC was using WRONG send-message skill" gotcha recorded in the
	 * project knowledge base on 2026-05-05.
	 *
	 * Spec provenance: 4-piece skill-mistake fix dispatch piece #2
	 * (Sam→Quinn, post-PR #446 merge).
	 */
	private buildOrchestratorComms(config: ModuleConfig): string {
		const reportStatusJson = `{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}`;
		const sendMessageJson = '{"to":"<session>","message":"<msg>"}';
		const reportCliFlags = `--session "${config.sessionName}" --status "<status>" --summary "<summary>" --project "${config.projectPath || config.projectRoot}"`;
		const sendCliFlags = '--to "<session>" --message "<msg>"';
		// Derived from projectRoot to keep ModuleConfig surface small. If we ever
		// need this in more modules, promote to `config.orchestratorSkillsPath`.
		const orchestratorSkillsPath = path.join(config.projectRoot, 'config', 'skills', 'orchestrator');
		// Orc uses the orc-namespaced send-message wrapper, NOT core/send-message.
		// See class-level JSDoc above for the rationale.
		const sendExample = this.buildOrcSkillExample(orchestratorSkillsPath, 'send-message', sendMessageJson, sendCliFlags, config.runtimeType);
		const reportExample = this.buildSkillExample(config, 'core/report-status', reportStatusJson, reportCliFlags);

		return this.buildOrchestratorCommsBody(config, sendExample, reportExample);
	}

	/**
	 * Build a bash example using an orc-namespaced skill path (vs the agent-side
	 * `core/<skill>` path used by {@link buildSkillExample}). Mirrors
	 * `buildSkillExample` for shape consistency but resolves the path under
	 * `config/skills/orchestrator/<skill>/` and never falls back to a heredoc
	 * since orc-namespaced skills are uniformly CLI-flag-friendly.
	 *
	 * Spec provenance: 4-piece skill-mistake fix dispatch piece #2.
	 *
	 * @param orchestratorSkillsPath - Absolute path to `config/skills/orchestrator/`
	 * @param skillName - Skill directory name under the orc-namespace (e.g. `send-message`)
	 * @param jsonExample - Inline JSON example for non-gemini runtimes
	 * @param cliExample - CLI flags example for gemini-cli runtimes
	 * @param runtimeType - Runtime type to choose JSON vs CLI rendering
	 * @returns Formatted bash code block invoking the orc-namespaced skill
	 */
	private buildOrcSkillExample(
		orchestratorSkillsPath: string,
		skillName: string,
		jsonExample: string,
		cliExample: string,
		runtimeType?: ModuleConfig['runtimeType'],
	): string {
		if (runtimeType === 'gemini-cli') {
			return `\`\`\`bash
bash ${orchestratorSkillsPath}/${skillName}/execute.sh ${cliExample}
\`\`\``;
		}
		return `\`\`\`bash
bash ${orchestratorSkillsPath}/${skillName}/execute.sh '${jsonExample}'
\`\`\``;
	}

	/**
	 * Build the body of the orchestrator Communication section. Split out from
	 * {@link buildOrchestratorComms} so the per-piece example construction stays
	 * isolated from the long Slack/Chat/NOTIFY markdown body.
	 */
	private buildOrchestratorCommsBody(config: ModuleConfig, sendExample: string, reportExample: string): string {
		const orchestratorSkillsPath = path.join(config.projectRoot, 'config', 'skills', 'orchestrator');
		void config; // reserved for future per-config formatting hooks

		return `## Communication Protocol

### Message Channels
You have access to multiple communication channels:
- **Slack** — Primary external channel for user communication
- **Chat UI** — Web-based chat interface
- **Google Chat** — Alternative messaging platform
- **NOTIFY markers** — Internal agent-to-orchestrator signaling

### Message Routing Rules — Reply on the SAME Channel
1. **\`[CHAT:...]\` prefix** → Message from Chat UI → Use \`reply-chat\` skill
2. **\`[GCHAT:...]\` prefix** → Message from Google Chat → Use \`reply-gchat\` skill
3. **\`[SLACK:...]\` marker** → Message from Slack → Use \`reply-slack\` skill
4. **\`[REMOTE:...]\` marker** → Message from remote device → Use \`reply-remote\` skill
5. **Agent status updates** → Process internally, do not forward to user unless requested
6. **Task completions / Error notifications** → Notify user on their active channel

**CRITICAL:** Match the reply skill to the message source prefix. Never use \`reply-slack\` for a \`[GCHAT:...]\` message or vice versa.

### Slack Communication
- Use \`reply-slack\` skill to send messages to Slack threads
- Triggered when you see a \`[SLACK:channelId:threadTs]\` marker on the message
- Always reply in the **same thread** the user messaged from
- Format messages using Slack mrkdwn (not standard Markdown):
  - Bold: \`*text*\` (not \`**text**\`)
  - Italic: \`_text_\` (not \`*text*\`)
  - Code: \`\\\`code\\\`\` (same as Markdown)
  - Links: \`<url|text>\` (not \`[text](url)\`)
- Keep messages concise — avoid walls of text in Slack

### Google Chat Communication
- Use \`reply-gchat\` skill to send messages to Google Chat threads
- Triggered when you see a \`[GCHAT:conversationId thread=spaceName]\` prefix on the message
- Extract the \`thread=\` value from the prefix and pass it as \`--thread\` to reply-gchat
- Extract the space from the conversationId and pass it as \`--space\` to reply-gchat
- Standard Markdown formatting is supported in Google Chat
- Keep messages concise and actionable

### Chat UI Communication
- Use \`reply-chat\` skill for Chat UI responses
- Triggered when you see a \`[CHAT:...]\` prefix without \`GCHAT\` or \`SLACK\` markers
- Standard Markdown formatting is supported
- Include structured data (tables, code blocks) when helpful

### Notification Protocol
- **[NOTIFY]** markers signal events that need orchestrator attention
- Process NOTIFY events by evaluating priority and routing appropriately
- Never forward raw NOTIFY markers to end users

### Thread Context
- Maintain thread continuity — always reference the active thread
- When switching channels, summarize context for the new channel
- Track channelId and threadTs for Slack thread replies

### Acknowledge-First Rule (MANDATORY)
When you receive a message from the user (via Slack, Chat UI, or Google Chat):
1. **Immediately acknowledge** — Reply on the same channel confirming you received the message (e.g., "Got it, working on this now")
2. **Then execute** — Start working on the task after the acknowledgment is sent
3. **Never work silently** — The user should always see an immediate response before you start any long-running work

This prevents the user from wondering if their message was received or if the agent is stuck.

### Communication Skills

**Orc-namespace gate (MANDATORY):** the agent-side skills under \`config/skills/agent/core/\` excludes orchestrator from \`assignableRoles\` for a reason. Reaching for them from this orchestrator session bypasses the orc-routing layer (e.g. agent-side \`send-message\` writes raw bytes to a peer's PTY via \`/terminal/{session}/write\` without readiness gating; orc-side \`send-message\` uses \`/terminal/{session}/deliver\` with the readiness-aware two-step delivery pattern). Always reach for \`${orchestratorSkillsPath}/<skill>/\` first. Orc-namespaced equivalents you have:
- \`send-message\` (orc-namespaced) — readiness-aware delivery via \`/terminal/{session}/deliver\` (NOT raw \`/write\`)
- \`record-success\` / \`record-failure\` / \`report-bug\` (orc-namespaced) — orc-side status recording
- \`broadcast\` / \`broadcast-to-org\` (orc-namespaced) — multi-agent fan-out
- \`reply-chat\` / \`reply-slack\` / \`reply-gchat\` / \`reply-remote\` (orc-namespaced) — owner-facing replies routed back to the source channel
- \`schedule-check\` / \`create-cron\` / \`cancel-schedule\` (orc-namespaced) — orc-side scheduling primitives
- Memory access: orc reads cross-agent memory via the internal \`recallFromAllAgents()\` (memory.service.ts:1047), NOT via the agent-side \`recall\` skill which excludes orchestrator from assignableRoles.

${reportExample}
${sendExample}`;
	}

	/**
	 * TL communication — delegation-focused messaging plus basic user comms.
	 */
	private buildTLComms(config: ModuleConfig): string {
		const reportStatusJson = `{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}`;
		const sendMessageJson = '{"to":"<worker-session>","message":"<task or feedback>"}';
		const delegateTaskJson = `{"to":"<worker-session>","task":"<task description>","priority":"high","teamId":"${config.teamId || ''}","tlMemberId":"${config.memberId}","projectPath":"${config.projectPath || config.projectRoot}"}`;
		const reportCliFlags = `--session "${config.sessionName}" --status "<status>" --summary "<summary>" --project "${config.projectPath || config.projectRoot}"`;
		const sendCliFlags = '--to "<worker-session>" --message "<task or feedback>"';
		const delegateCliFlags = `--to "<worker-session>" --task "<task description>" --priority high --project "${config.projectPath || config.projectRoot}" --team "${config.teamId || ''}" --tl-member "${config.memberId}"`;
		const reportExample = this.buildSkillExample(config, 'core/report-status', reportStatusJson, reportCliFlags);
		const sendExample = this.buildSkillExample(config, 'core/send-message', sendMessageJson, sendCliFlags);
		const delegateExample = this.buildSkillExample(config, 'delegate-task', delegateTaskJson, delegateCliFlags, config.tlSkillsPath);

		return `## Communication Protocol

### Reporting to Orchestrator
Use \`report-status\` to keep the orchestrator informed of progress:
${reportExample}

### Messaging Workers
Use \`send-message\` to communicate with your subordinates:
${sendExample}

### Delegating Tasks
Use \`delegate-task\` to assign tasks to your subordinates:
${delegateExample}

### Communication Rules
1. **Report up** — Keep orchestrator informed of progress and blockers
2. **Direct workers** — Send clear, actionable messages to subordinates
3. **Include context** — Always include task ID and acceptance criteria in delegations
4. **Use [TL_REPORT]** — Tag all reports to orchestrator with \`[TL_REPORT]\`
5. **Thread continuity** — Reference previous messages when following up`;
	}

	/**
	 * Worker communication — compact report-status and send-message only.
	 */
	private buildWorkerComms(config: ModuleConfig): string {
		const reportStatusJson = `{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}`;
		const sendMessageJson = '{"to":"<session>","message":"<msg>"}';
		const reportCliFlags = `--session "${config.sessionName}" --status "<status>" --summary "<summary>" --project "${config.projectPath || config.projectRoot}"`;
		const sendCliFlags = '--to "<session>" --message "<msg>"';
		const reportExample = this.buildSkillExample(config, 'core/report-status', reportStatusJson, reportCliFlags);
		const sendExample = this.buildSkillExample(config, 'core/send-message', sendMessageJson, sendCliFlags);

		return `## Communication

### Reporting Progress
Use \`report-status\` to update your team leader on task progress:
${reportExample}

### Messaging
Use \`send-message\` to communicate with other agents:
${sendExample}

### Rules
- Report progress periodically so your team leader stays informed
- Report blockers immediately — don't wait
- Keep messages concise and actionable`;
	}
}
