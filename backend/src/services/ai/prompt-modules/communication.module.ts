import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

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

		if (isOrchestrator) {
			return this.buildOrchestratorComms(config);
		}
		if (isTL) {
			return this.buildTLComms(config);
		}
		return this.buildWorkerComms(config);
	}

	/**
	 * Full orchestrator communication spec — Slack, Chat UI, NOTIFY markers,
	 * thread management, message formatting, and notification protocol.
	 */
	private buildOrchestratorComms(config: ModuleConfig): string {
		return `## Communication Protocol

### Message Channels
You have access to multiple communication channels:
- **Slack** — Primary external channel for user communication
- **Chat UI** — Web-based chat interface
- **Google Chat** — Alternative messaging platform
- **NOTIFY markers** — Internal agent-to-orchestrator signaling

### Message Routing Rules
1. **User messages** → Reply on the same channel they used (Slack → Slack, Chat → Chat)
2. **Agent status updates** → Process internally, do not forward to user unless requested
3. **Error notifications** → Notify user on their active channel
4. **Task completions** → Summarize and notify user on their active channel

### Slack Communication
- Use \`reply-slack\` skill to send messages to Slack threads
- Always reply in the **same thread** the user messaged from
- Format messages using Slack mrkdwn (not standard Markdown):
  - Bold: \`*text*\` (not \`**text**\`)
  - Italic: \`_text_\` (not \`*text*\`)
  - Code: \`\\\`code\\\`\` (same as Markdown)
  - Links: \`<url|text>\` (not \`[text](url)\`)
- Keep messages concise — avoid walls of text in Slack

### Chat UI Communication
- Use \`reply-chat\` skill for Chat UI responses
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

### Communication Skills
\`\`\`bash
bash ${config.agentSkillsPath}/core/report-status/execute.sh '{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}'
\`\`\`
\`\`\`bash
bash ${config.agentSkillsPath}/core/send-message/execute.sh '{"to":"<session>","message":"<msg>"}'
\`\`\``;
	}

	/**
	 * TL communication — delegation-focused messaging plus basic user comms.
	 */
	private buildTLComms(config: ModuleConfig): string {
		return `## Communication Protocol

### Reporting to Orchestrator
Use \`report-status\` to keep the orchestrator informed of progress:
\`\`\`bash
bash ${config.agentSkillsPath}/core/report-status/execute.sh '{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}'
\`\`\`

### Messaging Workers
Use \`send-message\` to communicate with your subordinates:
\`\`\`bash
bash ${config.agentSkillsPath}/core/send-message/execute.sh '{"to":"<worker-session>","message":"<task or feedback>"}'
\`\`\`

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
		return `## Communication

### Reporting Progress
Use \`report-status\` to update your team leader on task progress:
\`\`\`bash
bash ${config.agentSkillsPath}/core/report-status/execute.sh '{"sessionName":"${config.sessionName}","status":"<status>","summary":"<summary>","projectPath":"${config.projectPath || config.projectRoot}"}'
\`\`\`

### Messaging
Use \`send-message\` to communicate with other agents:
\`\`\`bash
bash ${config.agentSkillsPath}/core/send-message/execute.sh '{"to":"<session>","message":"<msg>"}'
\`\`\`

### Rules
- Report progress periodically so your team leader stays informed
- Report blockers immediately — don't wait
- Keep messages concise and actionable`;
	}
}
