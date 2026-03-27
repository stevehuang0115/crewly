/**
 * Prompt Guard Service — Prompt Injection Protection
 *
 * Detects and blocks prompt injection attempts that try to extract API keys,
 * secrets, or sensitive environment variables through agent commands.
 *
 * Integrates with the tool registry to block dangerous bash commands and
 * logs blocked attempts to the audit trail.
 *
 * @module services/agent/crewly-agent/prompt-guard.service
 *
 * @example
 * ```typescript
 * const guard = new PromptGuardService();
 * const result = guard.checkCommand('echo $ANTHROPIC_API_KEY');
 * // { blocked: true, reason: 'Key extraction attempt: echo env var', pattern: '...' }
 * ```
 */

import type { AuditEntry, ToolSensitivity } from './types.js';

/**
 * A pattern that detects key extraction attempts.
 */
export interface GuardPattern {
  /** Regex to match the dangerous command or prompt */
  pattern: RegExp;
  /** Human-readable reason for blocking */
  reason: string;
  /** Category for audit logging */
  category: 'env_extraction' | 'key_dump' | 'prompt_injection' | 'file_exfiltration';
}

/**
 * Result of a prompt guard check.
 */
export interface GuardCheckResult {
  /** Whether the command/prompt was blocked */
  blocked: boolean;
  /** Reason for blocking (empty if not blocked) */
  reason: string;
  /** Category of the threat (undefined if not blocked) */
  category?: GuardPattern['category'];
  /** The matched pattern source (for audit logging) */
  matchedPattern?: string;
}

/**
 * Patterns that detect attempts to extract API keys or secrets via bash commands.
 */
export const KEY_EXTRACTION_PATTERNS: readonly GuardPattern[] = [
  // Direct env var echo/print
  {
    pattern: /\becho\s+\$[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i,
    reason: 'Attempt to echo sensitive environment variable',
    category: 'env_extraction',
  },
  {
    pattern: /\bprintf\s+.*\$[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i,
    reason: 'Attempt to printf sensitive environment variable',
    category: 'env_extraction',
  },
  // env/printenv with grep for secrets
  {
    pattern: /\benv\b.*\|\s*grep\s+.*(?:KEY|SECRET|TOKEN|PASSWORD|API|AUTH)/i,
    reason: 'Attempt to grep env for secrets',
    category: 'env_extraction',
  },
  {
    pattern: /\bprintenv\b.*(?:KEY|SECRET|TOKEN|PASSWORD|API|AUTH)/i,
    reason: 'Attempt to printenv sensitive variable',
    category: 'env_extraction',
  },
  // set | grep (bash set command dumps all vars)
  {
    pattern: /\bset\b\s*\|\s*grep\s+.*(?:KEY|SECRET|TOKEN|PASSWORD|API|AUTH)/i,
    reason: 'Attempt to dump shell variables and grep for secrets',
    category: 'env_extraction',
  },
  // Reading sensitive config files (must come before bare env/printenv to avoid early match on "cat .env")
  {
    pattern: /\bcat\s+.*\.env\b/i,
    reason: 'Attempt to read .env file',
    category: 'file_exfiltration',
  },
  {
    pattern: /\bcat\s+.*(?:credentials|secrets|\.aws\/credentials|\.npmrc|\.netrc|\.pgpass)/i,
    reason: 'Attempt to read credentials file',
    category: 'file_exfiltration',
  },
  {
    pattern: /\bcat\s+.*\/etc\/shadow\b/i,
    reason: 'Attempt to read system password file',
    category: 'file_exfiltration',
  },
  // Direct env dump
  {
    pattern: /\benv\s*$/i,
    reason: 'Attempt to dump all environment variables',
    category: 'key_dump',
  },
  {
    pattern: /\bprintenv\s*$/i,
    reason: 'Attempt to dump all environment variables',
    category: 'key_dump',
  },
  // compgen dumps shell vars/functions
  {
    pattern: /\bcompgen\s+-[ev]/i,
    reason: 'Attempt to dump shell variables via compgen',
    category: 'key_dump',
  },
  // base64 encoding secrets for exfiltration
  {
    pattern: /\bbase64\b.*\$[A-Z_]*(?:KEY|SECRET|TOKEN)/i,
    reason: 'Attempt to base64 encode secret for exfiltration',
    category: 'file_exfiltration',
  },
  // curl/wget exfiltration of env vars
  {
    pattern: /\b(?:curl|wget)\b.*\$[A-Z_]*(?:KEY|SECRET|TOKEN)/i,
    reason: 'Attempt to exfiltrate secret via HTTP request',
    category: 'file_exfiltration',
  },
  // Python/Node one-liners to access env
  {
    pattern: /\bpython[23]?\s+-c\s+.*os\.environ/i,
    reason: 'Attempt to access env via Python subprocess',
    category: 'env_extraction',
  },
  {
    pattern: /\bnode\s+-e\s+.*process\.env/i,
    reason: 'Attempt to access env via Node subprocess',
    category: 'env_extraction',
  },
  // Specific key variable names in $() or backtick subshells
  {
    pattern: /\$\(.*(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AWS_SECRET|STRIPE_SECRET)/i,
    reason: 'Attempt to expand sensitive env var in subshell',
    category: 'env_extraction',
  },
] as const;

/**
 * Prompt-level injection patterns (detected in natural language prompts, not just commands).
 */
export const PROMPT_INJECTION_PATTERNS: readonly GuardPattern[] = [
  {
    pattern: /(?:print|show|reveal|tell\s+me|display|output|give\s+me|share)\s+(?:(?:your|the|my|me\s+the)\s+)?(?:api[_ ]?key|secret|token|password|credentials)/i,
    reason: 'Prompt injection: request to reveal API key/secret',
    category: 'prompt_injection',
  },
  {
    pattern: /(?:what\s+is|what's)\s+(?:your|the|my)\s+(?:api[_ ]?key|secret[_ ]?key|auth[_ ]?token|password)/i,
    reason: 'Prompt injection: question about API key/secret',
    category: 'prompt_injection',
  },
  {
    pattern: /ignore\s+(?:previous|all|your)\s+(?:instructions|rules|safety)/i,
    reason: 'Prompt injection: instruction override attempt',
    category: 'prompt_injection',
  },
  {
    pattern: /(?:override|bypass|disable|turn\s+off)\s+(?:security|safety|filter|guardrail|redaction)/i,
    reason: 'Prompt injection: attempt to disable security filters',
    category: 'prompt_injection',
  },
] as const;

/**
 * Additional blocked command patterns for tool-registry.ts integration.
 * These extend the existing BLOCKED_COMMAND_PATTERNS with key extraction blocks.
 */
export const KEY_EXTRACTION_BLOCKED_COMMANDS: RegExp[] = [
  /\benv\s*$/i,
  /\bprintenv\s*$/i,
  /\benv\b.*\|\s*grep\s+.*(?:KEY|SECRET|TOKEN|PASSWORD|API)/i,
  /\bset\b\s*\|\s*grep\s+.*(?:KEY|SECRET|TOKEN|PASSWORD|API)/i,
  /\bcompgen\s+-[ev]/i,
  /\bcat\s+.*\.env\b/i,
  /\bcat\s+.*(?:credentials|secrets|\.aws\/credentials|\.npmrc|\.netrc|\.pgpass)/i,
];

/**
 * Service that detects and blocks prompt injection and key extraction attempts.
 */
export class PromptGuardService {
  private readonly commandPatterns: readonly GuardPattern[];
  private readonly promptPatterns: readonly GuardPattern[];

  /**
   * Creates a new PromptGuardService.
   *
   * @param additionalCommandPatterns - Extra command-level patterns
   * @param additionalPromptPatterns - Extra prompt-level patterns
   */
  constructor(
    additionalCommandPatterns?: GuardPattern[],
    additionalPromptPatterns?: GuardPattern[],
  ) {
    this.commandPatterns = additionalCommandPatterns
      ? [...KEY_EXTRACTION_PATTERNS, ...additionalCommandPatterns]
      : KEY_EXTRACTION_PATTERNS;
    this.promptPatterns = additionalPromptPatterns
      ? [...PROMPT_INJECTION_PATTERNS, ...additionalPromptPatterns]
      : PROMPT_INJECTION_PATTERNS;
  }

  /**
   * Checks a bash command for key extraction attempts.
   *
   * @param command - Raw bash command string
   * @returns Guard check result
   */
  checkCommand(command: string): GuardCheckResult {
    if (!command) {
      return { blocked: false, reason: '' };
    }

    for (const guard of this.commandPatterns) {
      if (guard.pattern.test(command)) {
        return {
          blocked: true,
          reason: guard.reason,
          category: guard.category,
          matchedPattern: guard.pattern.source,
        };
      }
    }

    return { blocked: false, reason: '' };
  }

  /**
   * Checks a user/agent prompt for injection attempts targeting secrets.
   *
   * @param prompt - The text prompt or message
   * @returns Guard check result
   */
  checkPrompt(prompt: string): GuardCheckResult {
    if (!prompt) {
      return { blocked: false, reason: '' };
    }

    for (const guard of this.promptPatterns) {
      if (guard.pattern.test(prompt)) {
        return {
          blocked: true,
          reason: guard.reason,
          category: guard.category,
          matchedPattern: guard.pattern.source,
        };
      }
    }

    return { blocked: false, reason: '' };
  }

  /**
   * Checks both command and prompt patterns.
   * Use this for comprehensive scanning of any agent input.
   *
   * @param text - Text to check (command or prompt)
   * @returns Guard check result
   */
  check(text: string): GuardCheckResult {
    const cmdResult = this.checkCommand(text);
    if (cmdResult.blocked) return cmdResult;
    return this.checkPrompt(text);
  }

  /**
   * Creates an audit entry for a blocked attempt.
   *
   * @param sessionName - Agent session that triggered the block
   * @param toolName - Tool that was used (e.g. 'bash_exec')
   * @param command - The blocked command
   * @param guardResult - The guard check result
   * @returns AuditEntry suitable for the audit log
   */
  createAuditEntry(
    sessionName: string,
    toolName: string,
    command: string,
    guardResult: GuardCheckResult,
  ): AuditEntry {
    return {
      timestamp: new Date().toISOString(),
      sessionName,
      toolName,
      sensitivity: 'destructive' as ToolSensitivity,
      args: {
        command,
        blockedReason: guardResult.reason,
        category: guardResult.category || 'unknown',
        matchedPattern: guardResult.matchedPattern || '',
      },
      success: false,
      error: `Blocked by prompt guard: ${guardResult.reason}`,
      durationMs: 0,
    };
  }
}
