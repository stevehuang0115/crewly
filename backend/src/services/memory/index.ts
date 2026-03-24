/**
 * Memory Services Module
 *
 * Provides services for managing agent and project memory.
 *
 * @module services/memory
 */

export { AgentMemoryService, type IAgentMemoryService, type TaskCompletionMetrics } from './agent-memory.service.js';
export { ProjectMemoryService, type IProjectMemoryService, type SearchResults } from './project-memory.service.js';
export { MemoryService, type IMemoryService, type RememberParams, type RecallParams, type RecallResult, type LearningParams, type RememberCategory, type MemoryScope as UnifiedMemoryScope } from './memory.service.js';
export { SessionMemoryService } from './session-memory.service.js';
export { DailyLogService } from './daily-log.service.js';
export { GoalTrackingService } from './goal-tracking.service.js';
export { LearningAccumulationService } from './learning-accumulation.service.js';
export { UserProfileService } from './user-profile.service.js';

// Re-export memory types for convenience
export type {
  AgentMemory,
  ProjectMemory,
  RoleKnowledgeEntry,
  PatternEntry,
  DecisionEntry,
  GotchaEntry,
  RelationshipEntry,
  LearningEntry,
  AgentPreferences,
  PerformanceMetrics,
  MemoryQueryOptions,
  MemoryQueryResult,
  MemoryScope,
  RoleKnowledgeCategory,
  PatternCategory,
  GotchaSeverity,
  RelationshipType,
  LearningCategory,
  SessionSummary,
  StartupBriefing,
  AgentIndexEntry,
  ProjectAgentsIndex,
  DailyLogEntry,
  LearningAccumulationEntry,
  SharedUserProfile,
} from '../../types/memory.types.js';
