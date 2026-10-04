/**
 * Who may read which provider API key through
 * `GET /api/settings/api-key/:provider` (#1024).
 *
 * Before, any badge-carrying agent got any key, with any `?skill=` and
 * `?runtime=` it liked, and nothing was logged. Now an agent gets a key only
 * when its own runtime or the skill it names needs it:
 *
 * - **Runtime.** The caller's runtime is looked up from its session (team
 *   member or orchestrator, after any runtime fallback), never taken from the
 *   query. A `?runtime=` naming another runtime is refused, so an agent
 *   cannot pull another runtime's override key. Without `?skill=`, the
 *   provider must be one its runtime itself uses
 *   ({@link RUNTIME_KEY_PROVIDERS}).
 * - **Skill.** `?skill=<id>` must name an installed skill that declares the
 *   provider's environment variable (`requires` / `optionalSecrets` in
 *   `skill.json` or the SKILL.md frontmatter) and that the caller's role may
 *   use (`assignableRoles`).
 *
 * The owner is not limited. Every read and refusal is logged with the
 * provider, the caller and the scope — never the key.
 *
 * @module services/settings/api-key-access.service
 */

import * as path from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { API_KEY_ENV_VARS, API_KEY_PROVIDERS, type ApiKeyProvider } from '../../types/settings.types.js';
import { ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES } from '../../constants.js';
import { StorageService } from '../core/storage.service.js';
import { getSkillService } from '../skill/skill.service.js';
import { effectiveRuntimeType } from '../runtime-fallback/effective-runtime.js';
import { parseSkillMd } from '../../utils/skill-md-parser.js';
import { LoggerService } from '../core/logger.service.js';
import type { CallerIdentity } from '../../middleware/caller-identity.middleware.js';

const logger = LoggerService.getInstance().createComponentLogger('ApiKeyAccess');

/**
 * The providers each runtime itself consumes. The CLIs that pick a model
 * provider by configuration (OpenCode, the Crewly Agent) may use any.
 */
export const RUNTIME_KEY_PROVIDERS: Readonly<Record<string, readonly ApiKeyProvider[]>> = Object.freeze({
  [RUNTIME_TYPES.CLAUDE_CODE]: ['anthropic'],
  [RUNTIME_TYPES.GEMINI_CLI]: ['gemini'],
  [RUNTIME_TYPES.ANTIGRAVITY_CLI]: ['gemini'],
  [RUNTIME_TYPES.CODEX_CLI]: ['openai'],
  [RUNTIME_TYPES.OPENCODE_CLI]: API_KEY_PROVIDERS,
  [RUNTIME_TYPES.CREWLY_AGENT]: API_KEY_PROVIDERS,
});

/** Refusal codes. */
export const API_KEY_ACCESS_ERRORS = Object.freeze({
  /** `?runtime=` names a runtime other than the caller's */
  RUNTIME_MISMATCH: 'api_key_runtime_mismatch',
  /** Neither the caller's runtime nor the named skill needs this provider */
  OUT_OF_SCOPE: 'api_key_out_of_scope',
  /** `?skill=` names no installed skill */
  UNKNOWN_SKILL: 'api_key_unknown_skill',
  /** The skill is not assignable to the caller's role */
  SKILL_NOT_FOR_ROLE: 'api_key_skill_not_for_role',
});

/** Who the agent is, as far as key scoping cares. */
export interface AgentKeyProfile {
  /** Effective runtime, when the session is known */
  runtime?: string;
  /** Role (`orchestrator`, `developer`, …), when the session is known */
  role?: string;
}

/** What a skill declares. */
export interface SkillKeyProfile {
  /** Providers whose env var the skill declares */
  providers: ApiKeyProvider[];
  /** `assignableRoles` (`*` = any) */
  assignableRoles: string[];
}

/** The decision for one read. */
export type ApiKeyAccessDecision =
  | { allowed: true; runtime?: string; skill?: string }
  | { allowed: false; code: string; message: string };

/** Injectable lookups (tests). */
export interface ApiKeyAccessDeps {
  agentProfile?: (session: string) => Promise<AgentKeyProfile>;
  skillProfile?: (skillId: string) => Promise<SkillKeyProfile | null>;
}

/** Lookups a test installs for requests that go through the route. */
let testDeps: ApiKeyAccessDeps | null = null;

/**
 * Replace the storage / skill lookups for route-level tests (null restores).
 *
 * @param deps - Lookups, or null
 */
export function setApiKeyAccessDepsForTesting(deps: ApiKeyAccessDeps | null): void {
  testDeps = deps;
}

/**
 * The provider an environment variable name belongs to.
 *
 * @param envVar - e.g. `OPENAI_API_KEY`
 * @returns Provider or undefined
 */
export function providerForEnvVar(envVar: string): ApiKeyProvider | undefined {
  return API_KEY_PROVIDERS.find((p) => API_KEY_ENV_VARS[p].includes(envVar));
}

/**
 * Runtime and role of an agent session, from storage.
 *
 * @param session - Agent session name
 * @returns Profile (empty for a session that is not a team member or the orchestrator)
 */
export async function defaultAgentProfile(session: string): Promise<AgentKeyProfile> {
  const storage = StorageService.getInstance();
  try {
    if (session === ORCHESTRATOR_SESSION_NAME) {
      const orc = await storage.getOrchestratorStatus();
      return { role: 'orchestrator', ...(orc?.runtimeType ? { runtime: effectiveRuntimeType(session, orc.runtimeType) } : {}) };
    }
    const found = await storage.findMemberBySessionName(session);
    if (!found) return {};
    const configured = found.member.runtimeType as string | undefined;
    return {
      role: String(found.member.role),
      ...(configured ? { runtime: effectiveRuntimeType(session, configured) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * String array from an unknown manifest field.
 *
 * @param value - Field value
 * @returns Strings in it
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * What an installed skill declares: the providers behind `requires` /
 * `optionalSecrets` (skill.json and SKILL.md frontmatter) and its roles.
 *
 * @param skillId - Skill id as the skill sends it (`transcribe-audio`) or the catalog id (`skill-transcribe-audio`)
 * @returns Profile, or null for no such skill
 */
export async function defaultSkillProfile(skillId: string): Promise<SkillKeyProfile | null> {
  const service = getSkillService();
  const skill = (await service.getSkill(skillId)) ?? (await service.getSkill(`skill-${skillId}`));
  if (!skill) return null;
  const dir = path.dirname(skill.promptFile);
  const declared: string[] = [];
  let roles: string[] = stringList(skill.assignableRoles);
  const jsonPath = path.join(dir, 'skill.json');
  if (existsSync(jsonPath)) {
    try {
      const manifest = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
      declared.push(...stringList(manifest.requires), ...stringList(manifest.optionalSecrets));
      if (roles.length === 0) roles = stringList(manifest.assignableRoles);
    } catch {
      /* an unreadable manifest declares nothing */
    }
  }
  const mdPath = path.join(dir, 'SKILL.md');
  if (existsSync(mdPath)) {
    try {
      const fm = parseSkillMd(await readFile(mdPath, 'utf-8')).frontmatter as Record<string, unknown>;
      declared.push(...stringList(fm.requires), ...stringList(fm.optionalSecrets));
    } catch {
      /* no frontmatter */
    }
  }
  const providers = [...new Set(declared.map(providerForEnvVar).filter((p): p is ApiKeyProvider => Boolean(p)))];
  return { providers, assignableRoles: roles };
}

/**
 * Decide whether a verified agent may read a provider's key.
 *
 * @param session - The agent's session (from its badge)
 * @param provider - Requested provider
 * @param query - `skill` / `runtime` from the request
 * @param deps - Lookups (tests)
 * @returns The decision; when allowed, the runtime and skill to resolve the key with
 */
export async function decideAgentApiKeyAccess(
  session: string,
  provider: ApiKeyProvider,
  query: { skill?: string; runtime?: string },
  deps: ApiKeyAccessDeps = {},
): Promise<ApiKeyAccessDecision> {
  const profile = await (deps.agentProfile ?? testDeps?.agentProfile ?? defaultAgentProfile)(session);

  if (query.runtime && query.runtime !== profile.runtime) {
    return {
      allowed: false,
      code: API_KEY_ACCESS_ERRORS.RUNTIME_MISMATCH,
      message: `This agent runs ${profile.runtime ?? 'no known runtime'}, not ${query.runtime}: it can only read keys for its own runtime.`,
    };
  }

  if (query.skill) {
    const skill = await (deps.skillProfile ?? testDeps?.skillProfile ?? defaultSkillProfile)(query.skill);
    if (!skill) {
      return { allowed: false, code: API_KEY_ACCESS_ERRORS.UNKNOWN_SKILL, message: `No installed skill '${query.skill}'.` };
    }
    const anyRole = skill.assignableRoles.length === 0 || skill.assignableRoles.includes('*');
    if (!anyRole && !(profile.role && skill.assignableRoles.includes(profile.role))) {
      return {
        allowed: false,
        code: API_KEY_ACCESS_ERRORS.SKILL_NOT_FOR_ROLE,
        message: `The skill '${query.skill}' is not assigned to this agent's role.`,
      };
    }
    if (skill.providers.includes(provider)) {
      return { allowed: true, skill: query.skill, ...(profile.runtime ? { runtime: profile.runtime } : {}) };
    }
    return {
      allowed: false,
      code: API_KEY_ACCESS_ERRORS.OUT_OF_SCOPE,
      message: `The skill '${query.skill}' does not declare a ${provider} key (requires / optionalSecrets).`,
    };
  }

  const needed = profile.runtime ? RUNTIME_KEY_PROVIDERS[profile.runtime] ?? [] : [];
  if (needed.includes(provider)) return { allowed: true, ...(profile.runtime ? { runtime: profile.runtime } : {}) };
  return {
    allowed: false,
    code: API_KEY_ACCESS_ERRORS.OUT_OF_SCOPE,
    message: `This agent's runtime (${profile.runtime ?? 'unknown'}) does not use a ${provider} key. A skill that needs one names itself with ?skill=<id>.`,
  };
}

/**
 * Log one key read or refusal. Never the key.
 *
 * @param entry - What happened
 */
export function logApiKeyRead(entry: {
  provider: string;
  identity: CallerIdentity;
  skill?: string;
  runtime?: string;
  outcome: 'served' | 'refused' | 'not-configured';
  code?: string;
}): void {
  const meta = {
    provider: entry.provider,
    caller: entry.identity.kind,
    via: entry.identity.via,
    ...(entry.identity.session ? { session: entry.identity.session } : {}),
    ...(entry.skill ? { skill: entry.skill } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    outcome: entry.outcome,
    ...(entry.code ? { code: entry.code } : {}),
  };
  if (entry.outcome === 'refused') logger.warn('API key read refused', meta);
  else logger.info('API key read', meta);
}
