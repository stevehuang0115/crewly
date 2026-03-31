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

		// Try loading role-specific fragment (orchestrator has the richest version)
		if (isOrchestrator) {
			const fragment = loadRoleFragment(config.projectRoot, config.role, 'communication');
			if (fragment) {
				return fragment;
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
	 */
	private buildOrchestratorComms(config: ModuleConfig): string {
		const reportStatusJson = `{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}`;
		const sendMessageJson = '{"to":"<session>","message":"<msg>"}';
		const reportCliFlags = `--session "${config.sessionName}" --status "<status>" --summary "<summary>" --project "${config.projectPath || config.projectRoot}"`;
		const sendCliFlags = '--to "<session>" --message "<msg>"';
		const reportExample = this.buildSkillExample(config, 'core/report-status', reportStatusJson, reportCliFlags);
		const sendExample = this.buildSkillExample(config, 'core/send-message', sendMessageJson, sendCliFlags);

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
