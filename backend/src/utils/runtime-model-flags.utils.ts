/**
 * Per-agent model selection for the PTY runtimes.
 *
 * Every harness exposes a launch flag that pins the model for the session
 * (the in-process Crewly Agent runtime takes its model in code instead):
 *
 * | runtime      | model flag            | reasoning effort                          |
 * |--------------|-----------------------|-------------------------------------------|
 * | claude-code  | `--model <name>`      | `--effort low|medium|high|xhigh|max`      |
 * | codex-cli    | `-m <name>`           | `-c model_reasoning_effort="<level>"`     |
 * | gemini-cli   | `-m <name>`           | —                                         |
 * | opencode-cli | `--model <prov/model>`| —                                         |
 * | antigravity-cli | `--model <slug>`   | `--effort low|medium|high|max`            |
 *
 * `buildRuntimeModelFlags` turns a member's `modelId` / `reasoningEffort`
 * into those flags; `injectRuntimeFlags` places any flag list right after
 * the harness binary in a launch command (`codex resume …` included) and
 * drops a pre-existing copy of the same flag so the member override wins
 * without tripping clap's "cannot be used multiple times".
 *
 * @module utils/runtime-model-flags
 */

import { ANTIGRAVITY_EFFORT_LEVELS, RUNTIME_TYPES } from '../constants.js';

/** Model names are passed to a shell: only the characters real model ids use. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Effort levels are single lowercase words (`low`, `xhigh`, …). */
const EFFORT_RE = /^[a-z][a-z0-9]{0,15}$/;

/** Flags that select a model / effort, per runtime, so an existing copy can be replaced. */
const MODEL_FLAG_NAMES: Record<string, string[]> = {
  [RUNTIME_TYPES.CLAUDE_CODE]: ['--model', '--effort'],
  [RUNTIME_TYPES.CODEX_CLI]: ['--model', '-m'],
  [RUNTIME_TYPES.GEMINI_CLI]: ['--model', '-m'],
  [RUNTIME_TYPES.OPENCODE_CLI]: ['--model', '-m'],
  [RUNTIME_TYPES.ANTIGRAVITY_CLI]: ['--model', '--effort'],
};

/** Runtime binaries, used to find the insertion point in a launch command. */
const RUNTIME_BINARY_RE: Record<string, RegExp> = {
  [RUNTIME_TYPES.CLAUDE_CODE]: /\bclaude\b/,
  // `codex resume <id>` takes the same global flags after the subcommand.
  [RUNTIME_TYPES.CODEX_CLI]: /\bcodex(?:\s+resume)?\b/,
  [RUNTIME_TYPES.GEMINI_CLI]: /\bgemini\b/,
  [RUNTIME_TYPES.OPENCODE_CLI]: /\bopencode\b/,
  [RUNTIME_TYPES.ANTIGRAVITY_CLI]: /\bagy\b/,
};

/**
 * Whether a model id is safe to put on a command line.
 *
 * @param modelId - Candidate model id
 * @returns True when it matches the allowed character set
 */
export function isSafeModelId(modelId: string | undefined): modelId is string {
  return typeof modelId === 'string' && MODEL_ID_RE.test(modelId);
}

/**
 * Whether a reasoning-effort level is safe to put on a command line.
 *
 * @param effort - Candidate level
 * @returns True when it is a single lowercase word
 */
export function isSafeReasoningEffort(effort: string | undefined): effort is string {
  return typeof effort === 'string' && EFFORT_RE.test(effort);
}

/**
 * Build the launch flags that pin a model (and optionally the reasoning
 * effort) for one runtime. Unknown runtimes and the in-process Crewly
 * Agent get no flags; unsafe values are ignored rather than quoted.
 *
 * @param runtimeType - The member's runtime
 * @param modelId - Model name as the harness expects it (`opus`, `gpt-5.6-sol`, `anthropic/claude-sonnet-4`)
 * @param reasoningEffort - Optional effort level (Claude Code / Codex / Antigravity only)
 * @returns Flags to insert after the binary, e.g. `['--model', 'opus']`
 *
 * @example
 * buildRuntimeModelFlags('codex-cli', 'gpt-5.6-sol', 'high')
 * // => ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"']
 */
export function buildRuntimeModelFlags(
  runtimeType: string,
  modelId?: string,
  reasoningEffort?: string,
): string[] {
  const model = isSafeModelId(modelId) ? modelId : undefined;
  const effort = isSafeReasoningEffort(reasoningEffort) ? reasoningEffort : undefined;
  switch (runtimeType) {
    case RUNTIME_TYPES.CLAUDE_CODE:
      return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
    case RUNTIME_TYPES.CODEX_CLI:
      return [
        ...(model ? ['-m', model] : []),
        ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      ];
    case RUNTIME_TYPES.GEMINI_CLI:
      return model ? ['-m', model] : [];
    case RUNTIME_TYPES.OPENCODE_CLI:
      return model ? ['--model', model] : [];
    case RUNTIME_TYPES.ANTIGRAVITY_CLI:
      // Slugs from `agy models` (e.g. gemini-3.8-flash-high). The interactive
      // TUI falls back to its default model on an unknown slug with a warning.
      return [
        ...(model ? ['--model', model] : []),
        ...(effort && ANTIGRAVITY_EFFORT_LEVELS.includes(effort) ? ['--effort', effort] : []),
      ];
    default:
      return [];
  }
}

/**
 * Remove an existing `<flag> <value>` / `<flag>=<value>` pair from a command.
 *
 * @param command - Launch command
 * @param flagName - e.g. `--model` or `-m`
 * @returns Command without that flag
 */
function stripFlag(command: string, flagName: string): string {
  const escaped = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\s)${escaped}(?:=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)(?=\\s|$)`, 'g');
  return command.replace(re, '$1').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Insert flags into a launch command right after the runtime binary
 * (`claude`, `codex`/`codex resume`, `gemini`, `opencode`, `agy`). A flag that is
 * already present in the command is replaced. When the binary is not found
 * (custom wrapper scripts), the flags go before
 * `--dangerously-skip-permissions` if present, else at the end.
 *
 * @param command - One launch command line (may carry a `VAR=1` prefix)
 * @param runtimeType - The runtime the command starts
 * @param flags - Flags to insert (already shell-safe)
 * @returns The rewritten command; unchanged when `flags` is empty
 *
 * @example
 * injectRuntimeFlags('codex -a never -s danger-full-access', 'codex-cli', ['-m', 'gpt-5.6-sol'])
 * // => 'codex -m gpt-5.6-sol -a never -s danger-full-access'
 */
export function injectRuntimeFlags(command: string, runtimeType: string, flags: string[]): string {
  if (flags.length === 0) return command;
  let cmd = command;
  const known = MODEL_FLAG_NAMES[runtimeType] ?? [];
  for (const flag of flags) {
    if (flag.startsWith('-') && known.includes(flag)) cmd = stripFlag(cmd, flag);
  }
  const flagStr = flags.join(' ');
  const binary = RUNTIME_BINARY_RE[runtimeType];
  if (binary && binary.test(cmd)) {
    return cmd.replace(binary, (m) => `${m} ${flagStr}`);
  }
  if (cmd.includes('--dangerously-skip-permissions')) {
    return cmd.replace('--dangerously-skip-permissions', `${flagStr} --dangerously-skip-permissions`);
  }
  return `${cmd} ${flagStr}`;
}
