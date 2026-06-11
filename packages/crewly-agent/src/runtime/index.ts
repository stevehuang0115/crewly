/**
 * Crewly Agent Runtime — Barrel Export
 *
 * Standalone runtime module. The OSS-side `CrewlyAgentRuntimeService`
 * (in-process variant) intentionally does not exist here — this package
 * IS the process; OSS spawns it as a subprocess and talks via the JSON
 * protocol implemented in `cli.ts`.
 *
 * @module runtime
 */

export { AgentRunnerService } from './agent-runner.service.js';
export { CrewlyApiClient } from './api-client.js';
export { ModelManager } from './model-manager.js';
export { InProcessLogBuffer, type LogEntry } from './in-process-log-buffer.js';
export { createTools, getToolNames } from './tool-registry.js';
export { createAuditorTools, getAuditorToolNames } from './auditor-tools.js';
export { AuditTrailService } from './audit-trail.service.js';
export { RateLimiter, RATE_LIMITER_DEFAULTS, type RateLimiterConfig } from './rate-limiter.js';
export { createWebSearchTool, formatAsMarkdown } from './web-search.tool.js';
export { loadCloudConfig, CloudNotLoggedInError, type CloudConfig } from './cloud-config.js';
export {
  type ModelProvider,
  type ModelConfig,
  type ConversationState,
  type CrewlyAgentConfig,
  type AgentRunResult,
  type ToolCallRecord,
  type ApiCallResult,
  type AuditEntry,
  type SecurityPolicy,
  type AuditLogFilters,
  MODEL_PROVIDERS,
  CREWLY_AGENT_DEFAULTS,
  WRITE_TOOLS,
  isModelProvider,
  isModelConfig,
} from './types.js';
