import { PromptModule, ModuleConfig, loadRoleFragment } from './prompt-module.interface.js';

/**
 * Lifecycle module — agent lifecycle behaviors and cognitive loop.
 *
 * Consolidates proactive monitoring, auto progress heartbeat,
 * work rhythm, session management, and the 4-stage cognitive
 * lifecycle (Intent → Observation → Strategy → Adaptation).
 *
 * Orchestrator/TL agents get the full lifecycle spec including
 * proactive monitoring and event subscription patterns.
 * Workers get a compact work-rhythm-only version.
 *
 * Sources: orchestrator prompt.md §Proactive Monitoring,
 *          §Auto Progress Heartbeat, §Session Management,
 *          developer prompt.md §Work Rhythm.
 */
export class LifecycleModule implements PromptModule {
	name = 'lifecycle';
	priority = 11;
	maxTokens = 800;
	compactable = true;

	/**
	 * Always included — all agents need lifecycle guidance.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the lifecycle section.
	 * Orchestrators/TLs get the full spec; workers get a compact version.
	 *
	 * @param config - Module configuration with agent details
	 * @returns Formatted markdown lifecycle section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const isOrchestrator = config.role === 'orchestrator';
		const isTL = config.canDelegate === true;

		// Try loading role-specific fragment
		if (isOrchestrator) {
			const fragment = loadRoleFragment(config.projectRoot, config.role, 'lifecycle');
			if (fragment) {
				return fragment;
			}
		}
		if (isOrchestrator || isTL) {
			return this.buildFullLifecycle(config);
		}
		return this.buildWorkerLifecycle(config);
	}

	/**
	 * Full lifecycle for orchestrators and team leaders —
	 * includes proactive monitoring, cognitive loop, heartbeat, and session management.
	 */
	private buildFullLifecycle(config: ModuleConfig): string {
		const skillsPath = config.agentSkillsPath;
		const sessionName = config.sessionName;
		const projectPath = config.projectPath || config.projectRoot;

		return `## Lifecycle Management

### Cognitive Lifecycle (4 Stages)
Continuously cycle through these stages during operation:

1. **Intent** — Determine what needs to happen next (read tasks, check goals)
2. **Observation** — Gather current state (team status, blockers, progress)
3. **Strategy** — Decide the best approach (delegate, implement, escalate)
4. **Adaptation** — Learn from results, adjust approach for next cycle

### Proactive Monitoring
- Periodically check team member status for idle/error states
- Use \`schedule-check\` to set follow-up reminders after delegations
- Monitor for stale tasks — if no progress in 15 minutes, investigate
- Track context window usage — save progress before running low

### Auto Progress Heartbeat
Report your status periodically to maintain visibility:
\`\`\`bash
bash ${skillsPath}/core/report-status/execute.sh '{"sessionName":"${sessionName}","status":"in_progress","summary":"<current activity>","projectPath":"${projectPath}"}'
\`\`\`

### Session Management
- **On startup**: Execute recovery protocol, load context, check pending work
- **During work**: Report progress, save learnings, delegate effectively
- **Before context runs low**: Save current state via \`record-learning\`
- **On shutdown**: Generate session summary for next session handoff

### Daily Workflow
1. Start → Recovery protocol → Check pending tasks
2. Process incoming messages and events
3. Execute cognitive lifecycle loop (Intent → Observation → Strategy → Adaptation)
4. Report progress at natural milestones
5. Save learnings and handoff summary before session ends`;
	}

	/**
	 * Compact lifecycle for workers — work rhythm and context management only.
	 */
	private buildWorkerLifecycle(config: ModuleConfig): string {
		const skillsPath = config.agentSkillsPath;
		const sessionName = config.sessionName;
		const projectPath = config.projectPath || config.projectRoot;

		return `## Work Rhythm

### On Session Start
1. Execute recovery protocol (recall + get-my-context)
2. Review recovered context for unfinished work or blockers
3. Report readiness to team leader

### During Work
- Report progress periodically so your team leader stays informed
- When you discover important patterns or gotchas, call \`record-learning\` immediately
- If you feel your context window is getting large, save progress:
\`\`\`bash
bash ${skillsPath}/core/record-learning/execute.sh '{"agentId":"${sessionName}","agentRole":"${config.role}","projectPath":"${projectPath}","learning":"Current progress: [what was done]. Remaining: [what is left]. Key findings: [important notes]"}'
\`\`\`

### Before Context Runs Low
- Proactively save your progress via \`record-learning\`
- Report current status so the team leader can reassign if needed`;
	}
}
