/**
 * Skill Executor Service
 *
 * Responsible for executing skills including script execution with
 * environment variable injection, browser automation coordination,
 * and MCP tool invocation.
 *
 * @module services/skill/skill-executor.service
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  SkillWithPrompt,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillScriptConfig,
  SkillBrowserConfig,
  SkillMcpToolConfig,
  SKILL_CONSTANTS,
} from '../../types/skill.types.js';
import { getSkillService } from './skill.service.js';
import { getSettingsService } from '../settings/settings.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getCredentialStoreService } from '../credential/credential-store.service.js';
import { GeminiCliWorkspaceHelper } from '../credential/helpers/gemini-cli-workspace.helper.js';
import {
  SkillCredentialRequirement,
  GoogleOAuthPayload,
  ApiKeyPayload,
  MissingCredentialError,
  InsufficientScopeError,
} from '../../types/credential.types.js';

/**
 * Result of process execution
 */
interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A secret value captured for a given skill execution. stdout/stderr will
 * have this value replaced with `<redacted:{label}>` before being returned
 * to callers (so the agent/LLM never sees raw credential values in output).
 *
 * @internal Exported for unit tests.
 */
export interface LiveSecret {
  value: string;
  label: string;
}

/**
 * Replace all occurrences of any live secret value in `text` with a
 * `<redacted:{label}>` placeholder.
 *
 * @internal Exported for unit tests; not part of the public service API.
 */
export function redactSecrets(text: string, secrets: LiveSecret[]): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  for (const { value, label } of secrets) {
    if (value && out.includes(value)) {
      // String.prototype.split+join is safe for all characters (no regex escaping).
      out = out.split(value).join(`<redacted:${label}>`);
    }
  }
  return out;
}

/**
 * Service for executing skills
 *
 * Handles:
 * - Script execution with environment variable injection
 * - Browser automation via Claude's Chrome MCP
 * - MCP tool invocation
 * - Composite skill orchestration
 */
export class SkillExecutorService {
  private readonly defaultTimeoutMs: number = SKILL_CONSTANTS.DEFAULTS.SCRIPT_TIMEOUT_MS;
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('SkillExecutorService');

  /** Lazy-instantiated helpers for credential refresh. */
  private geminiCliHelper: GeminiCliWorkspaceHelper | null = null;

  private getGeminiCliHelper(): GeminiCliWorkspaceHelper {
    if (!this.geminiCliHelper) {
      this.geminiCliHelper = new GeminiCliWorkspaceHelper(getCredentialStoreService());
    }
    return this.geminiCliHelper;
  }

  /**
   * Execute a skill by ID
   *
   * @param skillId - ID of the skill to execute
   * @param context - Execution context with agent and task information
   * @returns Execution result with success status and output
   */
  async executeSkill(skillId: string, context: SkillExecutionContext): Promise<SkillExecutionResult> {
    const startTime = Date.now();

    try {
      const skillService = getSkillService();
      const skill = await skillService.getSkill(skillId);

      if (!skill) {
        return {
          success: false,
          error: `Skill not found: ${skillId}`,
          durationMs: Date.now() - startTime,
        };
      }

      if (!skill.isEnabled) {
        return {
          success: false,
          error: `Skill is disabled: ${skill.name}`,
          durationMs: Date.now() - startTime,
        };
      }

      return await this.executeSkillInternal(skill, context);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a skill with the full skill object
   *
   * @param skill - Full skill object with prompt content
   * @param context - Execution context
   * @returns Execution result
   */
  async executeSkillInternal(
    skill: SkillWithPrompt,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();

    // Check if skill is enabled
    if (!skill.isEnabled) {
      return {
        success: false,
        error: `Skill is disabled: ${skill.name}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Check settings for execution type restrictions
    try {
      const settings = await getSettingsService().getSettings();

      if (!settings.skills.enableScriptExecution && skill.execution?.type === 'script') {
        return {
          success: false,
          error: 'Script execution is disabled in settings',
          durationMs: Date.now() - startTime,
        };
      }

      if (!settings.skills.enableBrowserAutomation && skill.execution?.type === 'browser') {
        return {
          success: false,
          error: 'Browser automation is disabled in settings',
          durationMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      // If settings can't be loaded, continue with defaults (allow execution)
      this.logger.warn('Failed to load settings, continuing with defaults', { error: error instanceof Error ? error.message : String(error) });
    }

    const executionType = skill.execution?.type ?? 'prompt-only';

    switch (executionType) {
      case 'script':
        return this.executeScript(skill, context);

      case 'browser':
        return this.executeBrowserAutomation(skill, context);

      case 'mcp-tool':
        return this.executeMcpTool(skill, context);

      case 'composite':
        return this.executeComposite(skill, context);

      case 'prompt-only':
        return {
          success: true,
          output: skill.promptContent,
          durationMs: Date.now() - startTime,
          data: { type: 'prompt-only' },
        };

      default:
        return {
          success: false,
          error: `Unknown execution type: ${executionType}`,
          durationMs: Date.now() - startTime,
        };
    }
  }

  /**
   * Execute a script-based skill
   *
   * @param skill - Skill with script configuration
   * @param context - Execution context
   * @returns Execution result
   */
  private async executeScript(
    skill: SkillWithPrompt,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const scriptConfig = skill.execution?.script;

    if (!scriptConfig) {
      return {
        success: false,
        error: 'Script configuration missing',
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Load environment variables + any live secrets for output redaction
      const { env, liveSecrets } = await this.buildEnvironmentWithSecrets(skill, context);

      // Determine script path
      const skillDir = path.dirname(skill.promptFile);
      const scriptPath = path.isAbsolute(scriptConfig.file)
        ? scriptConfig.file
        : path.join(skillDir, scriptConfig.file);

      // Verify script exists
      await fs.access(scriptPath);

      // Build command based on interpreter
      const { command, args } = this.getInterpreterCommand(scriptConfig.interpreter, scriptPath);

      // Execute script (spawnProcess applies redaction to stdout/stderr using liveSecrets)
      const result = await this.spawnProcess(command, args, {
        cwd: scriptConfig.workingDir || skillDir,
        env,
        timeout: scriptConfig.timeoutMs || this.defaultTimeoutMs,
        liveSecrets,
      });

      return {
        success: result.exitCode === 0,
        output: result.stdout,
        error: result.exitCode !== 0 ? result.stderr : undefined,
        durationMs: Date.now() - startTime,
        data: {
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Script execution failed',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute browser automation skill
   *
   * This returns instructions for Claude to use with the Chrome MCP.
   * The actual browser automation is performed by Claude using the
   * mcp__claude-in-chrome__* tools.
   *
   * @param skill - Skill with browser configuration
   * @param context - Execution context
   * @returns Execution result with browser automation prompt
   */
  private async executeBrowserAutomation(
    skill: SkillWithPrompt,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const browserConfig = skill.execution?.browser;

    if (!browserConfig) {
      return {
        success: false,
        error: 'Browser configuration missing',
        durationMs: Date.now() - startTime,
      };
    }

    // Build browser automation prompt for Claude
    const browserPrompt = this.buildBrowserAutomationPrompt(browserConfig, context);

    return {
      success: true,
      output: browserPrompt,
      durationMs: Date.now() - startTime,
      data: {
        type: 'browser-automation',
        url: browserConfig.url,
        requiresChromeMcp: true,
      },
    };
  }

  /**
   * Execute MCP tool skill
   *
   * Returns instructions for invoking the specified MCP tool.
   *
   * @param skill - Skill with MCP tool configuration
   * @param context - Execution context
   * @returns Execution result with MCP tool invocation prompt
   */
  private async executeMcpTool(
    skill: SkillWithPrompt,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const mcpConfig = skill.execution?.mcpTool;

    if (!mcpConfig) {
      return {
        success: false,
        error: 'MCP tool configuration missing',
        durationMs: Date.now() - startTime,
      };
    }

    // Build MCP tool invocation instructions
    const mcpPrompt = this.buildMcpToolPrompt(mcpConfig, context);

    return {
      success: true,
      output: mcpPrompt,
      durationMs: Date.now() - startTime,
      data: {
        type: 'mcp-tool',
        toolName: mcpConfig.toolName,
        defaultParams: mcpConfig.defaultParams,
      },
    };
  }

  /**
   * Execute composite skill (sequence of other skills)
   *
   * @param skill - Skill with composite configuration
   * @param context - Execution context
   * @returns Combined execution result
   */
  private async executeComposite(
    skill: SkillWithPrompt,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const compositeConfig = skill.execution?.composite;

    if (!compositeConfig || !compositeConfig.skillSequence.length) {
      return {
        success: false,
        error: 'Composite configuration missing or empty',
        durationMs: Date.now() - startTime,
      };
    }

    const results: SkillExecutionResult[] = [];
    const outputs: string[] = [];

    for (const skillId of compositeConfig.skillSequence) {
      const result = await this.executeSkill(skillId, context);
      results.push(result);

      if (result.output) {
        outputs.push(result.output);
      }

      if (!result.success && !compositeConfig.continueOnError) {
        return {
          success: false,
          error: `Skill ${skillId} failed: ${result.error}`,
          output: outputs.join('\n\n---\n\n'),
          durationMs: Date.now() - startTime,
          data: { results },
        };
      }
    }

    const allSucceeded = results.every((r) => r.success);

    return {
      success: allSucceeded,
      output: outputs.join('\n\n---\n\n'),
      durationMs: Date.now() - startTime,
      data: { results },
    };
  }

  /**
   * Build environment variables for script execution
   *
   * @param skill - Skill with environment configuration
   * @param context - Execution context
   * @returns Environment variables object
   */
  private async buildEnvironment(
    skill: SkillWithPrompt,
    context: SkillExecutionContext
  ): Promise<NodeJS.ProcessEnv> {
    // Preserved for callers (tests etc.) that don't need the liveSecrets list.
    const { env } = await this.buildEnvironmentWithSecrets(skill, context);
    return env;
  }

  /**
   * Build environment variables and collect the list of live secret values
   * that need to be redacted from the child process's output. Used by
   * `executeScript` to wire up per-execution output redaction.
   */
  private async buildEnvironmentWithSecrets(
    skill: SkillWithPrompt,
    context: SkillExecutionContext,
  ): Promise<{ env: NodeJS.ProcessEnv; liveSecrets: LiveSecret[] }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const liveSecrets: LiveSecret[] = [];

    // Add context variables
    env.CREWLY_AGENT_ID = context.agentId;
    env.CREWLY_ROLE_ID = context.roleId;
    if (context.projectId) env.CREWLY_PROJECT_ID = context.projectId;
    if (context.taskId) env.CREWLY_TASK_ID = context.taskId;
    if (context.userInput) env.CREWLY_USER_INPUT = context.userInput;

    // Resolve credential slots declared in the skill frontmatter.
    // Runs BEFORE .env-file loading so that a credential-injected var can
    // be overridden by an explicit .env entry if desired.
    if (skill.credentials && skill.credentials.length > 0) {
      await this.resolveAndInjectCredentials(
        skill.credentials,
        context,
        env,
        liveSecrets,
      );
    }

    const envConfig = skill.environment;
    if (!envConfig) return { env, liveSecrets };

    // Load from .env file if specified
    if (envConfig.file) {
      const skillDir = path.dirname(skill.promptFile);
      const envFilePath = path.join(skillDir, envConfig.file);

      try {
        const envContent = await fs.readFile(envFilePath, 'utf-8');
        const parsed = this.parseEnvFile(envContent);
        Object.assign(env, parsed);
      } catch (error) {
        this.logger.warn('Failed to load env file', { envFilePath });
      }
    }

    // Add inline variables (override file values)
    if (envConfig.variables) {
      Object.assign(env, envConfig.variables);
    }

    // Check required variables
    if (envConfig.required) {
      for (const varName of envConfig.required) {
        if (!env[varName]) {
          throw new Error(`Required environment variable missing: ${varName}`);
        }
      }
    }

    return { env, liveSecrets };
  }

  /**
   * For each credential requirement declared on the skill:
   * - Resolve it to a credential UUID (agent binding → skill default)
   * - Look up the credential, decrypt the payload
   * - Verify scopes (OAuth)
   * - Refresh tokens if near expiry
   * - Inject values into env vars named `CREWLY_CRED_<SLOT>_*`
   * - Register secret values for output redaction
   */
  private async resolveAndInjectCredentials(
    requirements: SkillCredentialRequirement[],
    context: SkillExecutionContext,
    env: NodeJS.ProcessEnv,
    liveSecrets: LiveSecret[],
  ): Promise<void> {
    const store = getCredentialStoreService();

    for (const req of requirements) {
      const bindingId = context.credentialBindings?.[req.slot] ?? req.default;

      if (!bindingId) {
        if (req.required) {
          throw new MissingCredentialError(req.slot, req.provider);
        }
        continue;
      }

      const entry = await store.getCredential(bindingId);
      if (entry.status === 'revoked') {
        throw new Error(
          `Credential '${entry.name}' (slot '${req.slot}') is revoked. Re-authorize before using this skill.`,
        );
      }

      const payload = await store.getPayload(bindingId);

      // Verify scopes for OAuth
      if (req.requiredScopes && req.requiredScopes.length > 0) {
        if (payload.type !== 'google-oauth') {
          throw new Error(
            `Slot '${req.slot}' declared requiredScopes but credential is type '${payload.type}'.`,
          );
        }
        const granted = new Set(payload.scopes);
        const missing = req.requiredScopes.filter((s) => !granted.has(s));
        if (missing.length > 0) {
          throw new InsufficientScopeError(
            req.slot,
            req.requiredScopes,
            payload.scopes,
          );
        }
      }

      const slotEnv = this.credentialEnvPrefix(req.slot);

      if (payload.type === 'google-oauth') {
        // Refresh if near expiry
        let finalPayload: GoogleOAuthPayload = payload;
        if (entry.helper === 'gemini-cli-workspace') {
          try {
            finalPayload = await this.getGeminiCliHelper().getAccessToken(
              entry,
              payload,
            );
          } catch (err) {
            // Bubble up — includes CredentialRevokedError with remediation
            throw err;
          }
        }

        env[`${slotEnv}_ACCESS_TOKEN`] = finalPayload.accessToken;
        env[`${slotEnv}_REFRESH_TOKEN`] = finalPayload.refreshToken;
        env[`${slotEnv}_TOKEN_TYPE`] = finalPayload.tokenType;
        env[`${slotEnv}_EXPIRES_AT`] = String(finalPayload.expiresAt);
        env[`${slotEnv}_SCOPES`] = finalPayload.scopes.join(' ');
        if (finalPayload.accountEmail) {
          env[`${slotEnv}_EMAIL`] = finalPayload.accountEmail;
        }

        // Redact both tokens from output
        liveSecrets.push({ value: finalPayload.accessToken, label: `${req.slot}:access_token` });
        liveSecrets.push({ value: finalPayload.refreshToken, label: `${req.slot}:refresh_token` });
      } else {
        // api-key
        const apiPayload = payload as ApiKeyPayload;
        env[slotEnv] = apiPayload.value;
        liveSecrets.push({ value: apiPayload.value, label: req.slot });
      }

      // Record usage (best-effort — don't block execution if this fails)
      try {
        await store.updateCredential(bindingId, {
          lastUsedAt: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.warn('Failed to update lastUsedAt for credential', {
          credentialId: bindingId,
        });
      }
    }
  }

  /**
   * Slot name to env var prefix. `gmail-drive` → `CREWLY_CRED_GMAIL_DRIVE`.
   */
  private credentialEnvPrefix(slot: string): string {
    return `CREWLY_CRED_${slot.toUpperCase().replace(/-/g, '_')}`;
  }

  /**
   * Parse .env file content into key-value pairs
   *
   * @param content - Content of .env file
   * @returns Parsed environment variables
   */
  private parseEnvFile(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();

        // Remove quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Get interpreter command and arguments for script execution
   *
   * @param interpreter - Script interpreter type
   * @param scriptPath - Path to the script file
   * @returns Command and arguments
   */
  private getInterpreterCommand(
    interpreter: string,
    scriptPath: string
  ): { command: string; args: string[] } {
    switch (interpreter) {
      case 'bash':
        return { command: 'bash', args: [scriptPath] };
      case 'python':
        return { command: 'python3', args: [scriptPath] };
      case 'node':
        return { command: 'node', args: [scriptPath] };
      default:
        return { command: interpreter, args: [scriptPath] };
    }
  }

  /**
   * Spawn a process and capture output
   *
   * @param command - Command to execute
   * @param args - Command arguments
   * @param options - Execution options
   * @returns Process result with stdout, stderr, and exit code
   */
  private spawnProcess(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      liveSecrets?: LiveSecret[];
    }
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutMs = options.timeout || this.defaultTimeoutMs;
      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (exitCode) => {
        clearTimeout(timeoutId);
        const secrets = options.liveSecrets ?? [];
        resolve({
          stdout: redactSecrets(stdout, secrets),
          stderr: redactSecrets(stderr, secrets),
          exitCode: exitCode ?? 1,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  /**
   * Build browser automation prompt for Claude
   *
   * @param config - Browser configuration
   * @param context - Execution context
   * @returns Formatted prompt for browser automation
   */
  private buildBrowserAutomationPrompt(
    config: SkillBrowserConfig,
    context: SkillExecutionContext
  ): string {
    let prompt = `## Browser Automation Task\n\n`;
    prompt += `Navigate to: ${config.url}\n\n`;
    prompt += `### Instructions\n${config.instructions}\n\n`;

    if (config.actions?.length) {
      prompt += `### Specific Actions\n`;
      config.actions.forEach((action, i) => {
        prompt += `${i + 1}. ${action}\n`;
      });
      prompt += '\n';
    }

    if (context.userInput) {
      prompt += `### User Context\n${context.userInput}\n\n`;
    }

    prompt += `*Use the Claude Chrome MCP tools (mcp__claude-in-chrome__*) to complete this task.*`;

    return prompt;
  }

  /**
   * Build MCP tool invocation prompt
   *
   * @param config - MCP tool configuration
   * @param context - Execution context
   * @returns Formatted prompt for MCP tool invocation
   */
  private buildMcpToolPrompt(config: SkillMcpToolConfig, context: SkillExecutionContext): string {
    let prompt = `## MCP Tool Invocation\n\n`;
    prompt += `Tool: ${config.toolName}\n\n`;

    if (config.defaultParams) {
      prompt += `### Default Parameters\n`;
      prompt += '```json\n';
      prompt += JSON.stringify(config.defaultParams, null, 2);
      prompt += '\n```\n\n';
    }

    if (context.userInput) {
      prompt += `### User Context\n${context.userInput}\n`;
    }

    return prompt;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let executorInstance: SkillExecutorService | null = null;

/**
 * Get the singleton SkillExecutorService instance
 *
 * @returns The SkillExecutorService instance
 */
export function getSkillExecutorService(): SkillExecutorService {
  if (!executorInstance) {
    executorInstance = new SkillExecutorService();
  }
  return executorInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetSkillExecutorService(): void {
  executorInstance = null;
}
