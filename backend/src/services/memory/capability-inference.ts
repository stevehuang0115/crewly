/**
 * Capability Inference
 *
 * Maps the tool names an agent actually invoked + a WorkItem's metadata
 * into canonical capability strings of the form `<category>:<resource>`
 * (e.g. `gmail:read`, `slack:post`, `oauth:gmail`).
 *
 * This is the bridge between the messy reality of "what tools were
 * called" and the clean abstraction "what can this team member do",
 * which the orchestrator queries before delegating external-access work.
 *
 * The mapping table is intentionally a static lookup: predictable,
 * easy to reason about, easy to extend. New tools register here in
 * one place, no code spelunking required.
 *
 * @module services/memory/capability-inference
 */

/**
 * Static mapping from tool name → capability strings the tool exercises.
 * Most tools map to one capability; a few (oauth-gated tools) map to
 * two (the action + the credential class) so a recall for either
 * dimension finds the agent.
 *
 * **Convention** for the value side:
 *   `<service>:<verb>` — service is the external system (`gmail`,
 *   `slack`, `github`, `chrome`, `code`), verb is the operation
 *   (`read`, `send`, `post`, `scrape`, `edit`).
 *   `oauth:<service>` — credential class, present when the tool's
 *   real-world capability requires an OAuth grant to a third party.
 *
 * Add new tools below in alphabetical order. Don't include built-in
 * read/recall tools (read_file, recall_memory) — they're universal
 * across all agents and would just inflate every capability query.
 */
export const TOOL_TO_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  // Browser / web
  chrome_scrape: ['chrome:scrape'],
  web_search: ['web:search'],
  fetch_url: ['web:fetch'],

  // Email (OAuth-gated)
  read_email_oauth: ['gmail:read', 'oauth:gmail'],
  send_email_oauth: ['gmail:send', 'oauth:gmail'],

  // Calendar
  read_calendar_oauth: ['calendar:read', 'oauth:calendar'],
  create_calendar_event: ['calendar:write', 'oauth:calendar'],

  // Slack (uses bot token, not OAuth-per-user, but the agent still
  // needs the bot grant to act on the channel)
  reply_slack: ['slack:post'],

  // GitHub (token-gated)
  gh_pr_create: ['github:pr-create', 'oauth:github'],
  gh_issue_comment: ['github:issue-comment', 'oauth:github'],

  // Code edits
  edit_file: ['code:edit'],
  write_file: ['code:write'],
  git_commit: ['git:commit'],

  // Shell — broad capability, weighted accordingly
  bash_exec: ['shell:exec'],

  // Task / team operations (cross-team coordination)
  delegate_task: ['coordination:delegate'],
  broadcast: ['coordination:broadcast'],
} as const;

/**
 * WorkItem-level capability hints. A WorkItem's `metadata.requires`
 * may explicitly list capabilities the parent requested (e.g. orc
 * said "needs gmail:read"). Surface those directly so a tool whose
 * mapping we haven't added yet still contributes to the right index.
 *
 * Treat this as additive: explicit requires + inferred-from-tools,
 * deduped at the caller.
 */
export function readWorkItemHints(workItem: Record<string, unknown>): string[] {
  const metadata = workItem['metadata'] as Record<string, unknown> | undefined;
  if (!metadata) return [];
  const requires = metadata['requires'];
  if (!Array.isArray(requires)) return [];
  return requires.filter((c): c is string => typeof c === 'string' && c.includes(':'));
}

/**
 * Infer capabilities exercised by a task.
 *
 * @param toolsUsed - Tool names called during the run
 * @param workItem - Optional WorkItem for metadata hints
 * @returns Deduped capability strings (no specific order)
 *
 * @example
 * ```typescript
 * inferCapabilities(['read_email_oauth'], { metadata: { requires: [] } });
 * // → ['gmail:read', 'oauth:gmail']
 * ```
 */
export function inferCapabilities(
  toolsUsed: readonly string[],
  workItem?: Record<string, unknown>,
): string[] {
  const set = new Set<string>();
  for (const tool of toolsUsed) {
    const caps = TOOL_TO_CAPABILITIES[tool];
    if (caps) {
      for (const c of caps) set.add(c);
    }
  }
  if (workItem) {
    for (const c of readWorkItemHints(workItem)) set.add(c);
  }
  return [...set];
}

/**
 * Injectable interface — the subscriber consumes only this shape so
 * test code can stub it. Production passes the default impl that
 * delegates to {@link inferCapabilities}.
 */
export interface CapabilityInferenceService {
  infer(toolsUsed: readonly string[], workItem?: Record<string, unknown>): string[];
}

/**
 * Default implementation backed by the static table. Exported so the
 * subscriber's constructor default is identity-stable across imports.
 */
export const defaultCapabilityInference: CapabilityInferenceService = {
  infer: inferCapabilities,
};
