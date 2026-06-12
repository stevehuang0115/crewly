/**
 * Onboarding mode prompt + skill allowlist loader (Onboarding v3 — B3).
 *
 * Resolves the onboarding-mode system prompt and skill allowlist that the
 * orc loads when cold-start detection (B1) fires. The real content is
 * authored by Max on `feat/onboarding-v3-orc-prompt-skills`:
 *
 * - `backend/src/services/orchestrator/prompts/onboarding-mode.prompt.ts`
 *   exports `ONBOARDING_MODE_SYSTEM_PROMPT: string`
 * - `backend/src/services/orchestrator/onboarding-mode.skill-allowlist.ts`
 *   exports `ONBOARDING_SKILL_ALLOWLIST: readonly string[]` plus
 *   `isOnboardingSkillAllowed(name)` / `filterAllowedOnboardingSkills(names)`.
 *
 * Until Max's branch merges, those modules don't exist on this branch.
 * This loader uses a dynamic-import-with-fallback so the build is atomic
 * and the orc still has *something* to load on a cold start. After Max's
 * branch merges, the real exports take over with no rebuild needed.
 *
 * Decoupled module path (string variable, not literal) is intentional —
 * keeps TypeScript's module resolver from emitting a compile error when
 * the target file is absent.
 *
 * @module services/orchestrator/onboarding-mode-loader
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/**
 * Default onboarding-mode system prompt — used when Max's prompt module
 * is not yet available. Mon EOD demo can run on this; Max replaces it
 * with the production prompt at the import path below when his branch
 * lands.
 */
export const ONBOARDING_FALLBACK_PROMPT =
  'You are Crewly, an AI team orchestrator. The user is onboarding for ' +
  'the first time. Greet them warmly, then ask about their business so ' +
  'you can recommend an initial AI team and workflow.';

/**
 * Default skill allowlist — used when Max's allowlist module is not yet
 * available. Matches the brief: recall / remember / record-learning +
 * the 2 onboarding-specific skills (`recommend-team`, `materialize-team`).
 * `delegate-task`, `start-agent`, `stop-agent` are intentionally absent.
 */
export const ONBOARDING_FALLBACK_ALLOWLIST: readonly string[] = Object.freeze([
  'recall',
  'remember',
  'record-learning',
  'recommend-team',
  'materialize-team',
  'synthesize-hierarchy',
]);

/**
 * Module specifiers that reach Max's exports after his branch merges.
 *
 * Stored in `let`-typed `string` variables (not literal strings or template
 * literals) so TypeScript treats the dynamic `import(spec)` call as
 * `Promise<any>` rather than attempting to resolve the path at compile
 * time. This keeps the build atomic even when the target files are absent.
 */
const PROMPT_MODULE_PATH: string = './prompts/onboarding-mode.prompt.js';
const ALLOWLIST_MODULE_PATH: string = './onboarding-mode.skill-allowlist.js';

const PROMPT_EXPORT_NAME = 'ONBOARDING_MODE_SYSTEM_PROMPT';
const ALLOWLIST_EXPORT_NAME = 'ONBOARDING_SKILL_ALLOWLIST';

let cachedPrompt: string | null = null;
let cachedAllowlist: readonly string[] | null = null;

const getLogger = (): ComponentLogger =>
  LoggerService.getInstance().createComponentLogger('OnboardingModeLoader');

/**
 * Dynamic import that swallows ENOENT-style failures.
 *
 * Cast to `unknown` so callers narrow with their own type guard — keeps
 * the loader safe even if Max changes the export shape unexpectedly.
 */
async function tryImport(specifier: string): Promise<unknown> {
  try {
    return (await import(specifier)) as unknown;
  } catch (err) {
    getLogger().debug('Dynamic import failed; using fallback', {
      specifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the onboarding-mode system prompt.
 *
 * On first call, attempts to load the production prompt module; on
 * subsequent calls returns the cached value. Failure (module missing,
 * export missing, wrong type) returns the fallback.
 *
 * @returns Onboarding-mode system prompt string
 */
export async function loadOnboardingPrompt(): Promise<string> {
  if (cachedPrompt !== null) return cachedPrompt;

  const mod = await tryImport(PROMPT_MODULE_PATH);
  if (mod && typeof mod === 'object' && PROMPT_EXPORT_NAME in mod) {
    const value = (mod as Record<string, unknown>)[PROMPT_EXPORT_NAME];
    if (typeof value === 'string' && value.length > 0) {
      getLogger().info('Loaded production onboarding prompt', {
        promptLength: value.length,
      });
      cachedPrompt = value;
      return cachedPrompt;
    }
  }

  getLogger().warn('Onboarding prompt module unavailable; using fallback stub');
  cachedPrompt = ONBOARDING_FALLBACK_PROMPT;
  return cachedPrompt;
}

/**
 * Resolve the onboarding-mode skill allowlist.
 *
 * Caching, fallback semantics, and validation mirror `loadOnboardingPrompt`.
 *
 * @returns Allowed skill names (kebab-case match against `mcp-tool-definitions`)
 */
export async function loadOnboardingSkillAllowlist(): Promise<readonly string[]> {
  if (cachedAllowlist !== null) return cachedAllowlist;

  const mod = await tryImport(ALLOWLIST_MODULE_PATH);
  if (mod && typeof mod === 'object' && ALLOWLIST_EXPORT_NAME in mod) {
    const value = (mod as Record<string, unknown>)[ALLOWLIST_EXPORT_NAME];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      getLogger().info('Loaded production onboarding skill allowlist', {
        count: value.length,
      });
      cachedAllowlist = Object.freeze([...(value as string[])]);
      return cachedAllowlist;
    }
  }

  getLogger().warn('Onboarding skill allowlist module unavailable; using fallback stub');
  cachedAllowlist = ONBOARDING_FALLBACK_ALLOWLIST;
  return cachedAllowlist;
}

/**
 * Reset the cached prompt + allowlist. Test-only helper.
 *
 * Production callers should leave the cache alone — the modules are
 * effectively immutable for the lifetime of the process.
 *
 * @internal
 */
export function _resetOnboardingModeLoaderForTesting(): void {
  cachedPrompt = null;
  cachedAllowlist = null;
}
