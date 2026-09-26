/**
 * Waiting Signal Pattern Definitions
 *
 * Patterns for detecting when an agent is waiting
 * for input, approval, or other agents.
 *
 * @module services/continuation/patterns/waiting-patterns
 */

/**
 * Patterns indicating agent is waiting for input
 */
export const INPUT_WAITING_PATTERNS: RegExp[] = [
  /waiting\s+for/i,
  /please\s+provide/i,
  /need\s+more\s+info/i,
  /\?\s*$/m,                          // Ends with question mark
  /what\s+should\s+I/i,
  /which\s+(one|option)/i,
  /please\s+specify/i,
  /enter\s+.*:/i,
  /input\s+required/i,
];

/**
 * Patterns indicating agent is waiting for approval
 */
export const APPROVAL_WAITING_PATTERNS: RegExp[] = [
  /waiting\s+for\s+(approval|review)/i,
  /please\s+(confirm|approve)/i,
  /ready\s+for\s+review/i,
  /needs?\s+approval/i,
  /pending\s+review/i,
  /awaiting\s+approval/i,
];

/**
 * Patterns indicating agent is waiting for another agent
 */
export const OTHER_AGENT_WAITING_PATTERNS: RegExp[] = [
  /waiting\s+for\s+\w+-\w+/i,         // Session name pattern like "team-dev"
  /blocked\s+by/i,
  /depends\s+on/i,
  /waiting\s+for\s+.*\s+to\s+complete/i,
  /need\s+.*\s+first/i,
];

/**
 * Patterns indicating agent is asking a question
 */
export const QUESTION_PATTERNS: RegExp[] = [
  /\?$/m,
  /should\s+I/i,
  /do\s+you\s+want/i,
  /would\s+you\s+like/i,
  /can\s+you\s+clarify/i,
  /what\s+would\s+you\s+prefer/i,
];

/**
 * Patterns indicating agent is stuck in plan mode
 * (Claude Code's interactive approval prompt that cannot be resolved via PTY input)
 *
 * Used (as PLAN_MODE_DISMISS_PATTERNS) to decide whether to send ESC before a
 * message is delivered. Every pattern must be specific to the plan-approval
 * menu: `shift+tab to cycle` was removed (#815) because it is in the footer of
 * EVERY idle Claude Code screen ("auto mode on (shift+tab to cycle)"), so ESC
 * was being sent to idle agents. Pinned by the captured-screen fixtures in
 * services/monitoring/agent-attention.test.ts.
 */
export const PLAN_MODE_PATTERNS: RegExp[] = [
  /Claude has written up a plan/i,
  /Ready to code\?/,
  /ExitPlanMode/,
  /Plan mode/,
];

/**
 * All waiting pattern categories
 */
export const WAITING_PATTERNS = {
  input: INPUT_WAITING_PATTERNS,
  approval: APPROVAL_WAITING_PATTERNS,
  otherAgent: OTHER_AGENT_WAITING_PATTERNS,
  question: QUESTION_PATTERNS,
  planMode: PLAN_MODE_PATTERNS,
} as const;
