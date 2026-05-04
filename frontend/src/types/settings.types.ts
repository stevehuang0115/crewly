/**
 * Frontend Settings Types
 *
 * Type definitions for Crewly application settings.
 * These types mirror the backend settings types.
 *
 * @module types/settings.types
 */

/**
 * Supported AI runtime types
 */
export type AIRuntime = 'claude-code' | 'gemini-cli' | 'codex-cli' | 'crewly-agent';

/**
 * General application settings
 */
export interface GeneralSettings {
  /** Default AI runtime for new agents */
  defaultRuntime: AIRuntime;
  /** Whether to auto-start the orchestrator on launch */
  autoStartOrchestrator: boolean;
  /** How often agents should check in (in minutes) */
  checkInIntervalMinutes: number;
  /** Maximum number of concurrent agents */
  maxConcurrentAgents: number;
  /** Enable verbose logging */
  verboseLogging: boolean;
  /** Whether to auto-resume agent sessions on restart */
  autoResumeOnRestart: boolean;
  /** Per-runtime CLI init commands. Key = runtime type, value = CLI command string */
  runtimeCommands: Record<AIRuntime, string>;
  /** Minutes of inactivity before an agent is automatically suspended (0 = disabled) */
  agentIdleTimeoutMinutes: number;
  /** Enable proactive context compaction based on cumulative terminal output volume */
  enableProactiveCompact: boolean;
  /** Enable Self Evolution mode — orchestrator monitors for errors and self-triages */
  enableSelfEvolution: boolean;
  /** Enable the auditor agent (quality observer that monitors agents and writes audit reports) */
  enableAuditor: boolean;
  /** Enable token usage tracking for agent sessions */
  tokenTracking?: boolean;
}

/**
 * Chat interface settings
 */
export interface ChatSettings {
  /** Show raw terminal output in chat */
  showRawTerminalOutput: boolean;
  /** Show typing indicator when agents are processing */
  enableTypingIndicator: boolean;
  /** Maximum number of messages to keep in history */
  maxMessageHistory: number;
  /** Automatically scroll to bottom on new messages */
  autoScrollToBottom: boolean;
  /** Show timestamps on messages */
  showTimestamps: boolean;
}

/**
 * Skills-related settings
 */
export interface SkillsSettings {
  /** Custom skills directory path */
  skillsDirectory: string;
  /** Enable browser automation skills */
  enableBrowserAutomation: boolean;
  /** Browser profile for anti-bot and headed/headless behavior */
  browserProfile?: {
    headless: boolean;
    stealth: boolean;
    humanDelayMinMs: number;
    humanDelayMaxMs: number;
  };
  /** Enable script execution skills */
  enableScriptExecution: boolean;
  /** Default skill execution timeout in milliseconds */
  skillExecutionTimeoutMs: number;
}

// ============================================================================
// API Key Management Types
// ============================================================================

/**
 * Supported AI provider names for API key management.
 *
 * Note: 'deepseek' is served via the OpenAI-compatible endpoint at
 * https://api.deepseek.com/v1, but is configured as a distinct provider
 * so users can save a separate API key in Settings. Mirrors the backend
 * `ApiKeyProvider` union (see backend/src/types/settings.types.ts).
 */
export type ApiKeyProvider = 'gemini' | 'anthropic' | 'openai' | 'deepseek';

/**
 * Array of all valid API key providers
 */
export const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = [
  'gemini',
  'anthropic',
  'openai',
  'deepseek',
] as const;

/**
 * Configuration for an API key override at runtime or skill level
 */
export interface ApiKeyConfig {
  /** The actual API key value (masked when returned from API) */
  key: string;
  /** Whether this uses the global key or a custom override */
  source: 'global' | 'custom';
}

/**
 * API Keys settings with global keys and per-level overrides
 */
export interface ApiKeysSettings {
  /** Global API keys available system-wide */
  global: {
    gemini?: string;
    anthropic?: string;
    openai?: string;
    deepseek?: string;
  };
  /** Per-runtime API key overrides */
  runtimeOverrides?: {
    [runtimeType: string]: {
      gemini?: ApiKeyConfig;
      anthropic?: ApiKeyConfig;
      openai?: ApiKeyConfig;
      deepseek?: ApiKeyConfig;
    };
  };
  /** Per-skill API key overrides */
  skillOverrides?: {
    [skillName: string]: {
      gemini?: ApiKeyConfig;
      anthropic?: ApiKeyConfig;
      openai?: ApiKeyConfig;
      deepseek?: ApiKeyConfig;
    };
  };
}

/**
 * Complete settings object
 */
export interface CrewlySettings {
  general: GeneralSettings;
  chat: ChatSettings;
  skills: SkillsSettings;
  apiKeys?: ApiKeysSettings;
}

/**
 * Partial settings update input
 */
export interface UpdateSettingsInput {
  general?: Partial<GeneralSettings>;
  chat?: Partial<ChatSettings>;
  skills?: Partial<SkillsSettings>;
  apiKeys?: Partial<ApiKeysSettings>;
}

/**
 * Settings validation result
 */
export interface SettingsValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Available AI runtimes
 */
export const AI_RUNTIMES: AIRuntime[] = ['claude-code', 'gemini-cli', 'codex-cli', 'crewly-agent'];

/**
 * AI runtime display names
 */
export const AI_RUNTIME_DISPLAY_NAMES: Record<AIRuntime, string> = {
  'claude-code': 'Claude Code',
  'gemini-cli': 'Gemini CLI',
  'codex-cli': 'Codex CLI',
  'crewly-agent': 'Crewly Agent',
};

/**
 * Get display name for an AI runtime
 *
 * @param runtime - AI runtime type
 * @returns Display name for the runtime
 */
export function getAIRuntimeDisplayName(runtime: AIRuntime): string {
  return AI_RUNTIME_DISPLAY_NAMES[runtime] || runtime;
}

/**
 * Check if a value is a valid AI runtime
 *
 * @param value - Value to check
 * @returns True if valid runtime
 */
export function isValidAIRuntime(value: string): value is AIRuntime {
  return AI_RUNTIMES.includes(value as AIRuntime);
}
