/**
 * Idle State Pattern Definitions
 *
 * Patterns for detecting when an agent has returned
 * to an idle state (shell prompt, Claude exited, etc.).
 *
 * @module services/continuation/patterns/idle-patterns
 */

/**
 * Patterns indicating shell prompt is visible (agent returned to shell).
 *
 * IMPORTANT: These patterns run against `tmux capture-pane` output to verify
 * that an agent CLI has actually exited back to the shell. They must be
 * specific enough to avoid false positives from normal CLI output (e.g.,
 * markdown `>` blockquotes, `$variable` references, `100%` progress bars).
 *
 * Each pattern requires a prompt-like prefix (username, path, or start-of-line)
 * to distinguish real shell prompts from incidental occurrences in output text.
 */
export const SHELL_PROMPT_PATTERNS: RegExp[] = [
  // user@host:path$ or ~/path$  (bash-style prompts)
  /[~\/\w].*\$\s*$/m,
  // user@host:path> or C:\path> (cmd/powershell-style prompts — requires path prefix)
  /[~\/\\:\w].*>\s*$/m,
  // ❯ is almost exclusively a shell prompt indicator (starship, powerline)
  /❯\s*$/m,
  // user@host:path% or host% (zsh-style prompts — requires prefix)
  /[~\/\w].*%\s*$/m,
  // Explicit versioned prompts
  /bash-\d+\.\d+\$\s*$/m,
  /zsh.*%\s*$/m,
  // Gemini CLI ready indicators
  /Type\s+your\s+message/i,
  /YOLO\s+mode/i,
];

/**
 * Patterns indicating Claude Code has exited or is idle
 */
export const CLAUDE_IDLE_PATTERNS: RegExp[] = [
  /Claude\s+(Code\s+)?exited/i,
  /Session\s+ended/i,
  /Goodbye/i,
  /claude\s+code\s+session\s+complete/i,
  /conversation\s+ended/i,
];

/**
 * Patterns indicating a process has completed
 */
export const PROCESS_COMPLETE_PATTERNS: RegExp[] = [
  /Done\s+in\s+\d+/i,
  /Finished\s+in\s+\d+/i,
  /Process\s+exited/i,
  /\[Process completed\]/i,
];

/**
 * All idle pattern categories
 */
export const IDLE_PATTERNS = {
  shellPrompt: SHELL_PROMPT_PATTERNS,
  claudeIdle: CLAUDE_IDLE_PATTERNS,
  processComplete: PROCESS_COMPLETE_PATTERNS,
} as const;
