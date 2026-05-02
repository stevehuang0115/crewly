/**
 * Orchestrator Service Module
 *
 * Exports orchestrator-related services.
 *
 * @module services/orchestrator
 */

export {
  StatePersistenceService,
  getStatePersistenceService,
  resetStatePersistenceService,
} from './state-persistence.service.js';

export {
  SafeRestartService,
  getSafeRestartService,
  resetSafeRestartService,
  type RestartConfig,
  type RestartStatus,
} from './safe-restart.service.js';

export {
  SelfImprovementService,
  getSelfImprovementService,
  resetSelfImprovementService,
  type ImprovementRequest,
  type ImprovementResult,
  type ImprovementPlan,
} from './self-improvement.service.js';

export {
  ImprovementMarkerService,
  getImprovementMarkerService,
  resetImprovementMarkerService,
  type ImprovementMarker,
  type ImprovementPhase,
  type ValidationResult,
  type FileBackupRecord,
} from './improvement-marker.service.js';

export {
  ImprovementStartupService,
  getImprovementStartupService,
  resetImprovementStartupService,
  type StartupResult,
} from './improvement-startup.service.js';

export {
  isOrchestratorActive,
  isAgentActive,
  getOrchestratorStatus,
  getOrchestratorOfflineMessage,
  type OrchestratorStatusResult,
} from './orchestrator-status.service.js';

export {
  OrchestratorRestartService,
  type RestartStats,
} from './orchestrator-restart.service.js';

export {
  triggerOrchestratorSetup,
  setOrchestratorSetupDependencies,
  type OrchestratorSetupResult,
  type AgentRegistrationServiceLike,
} from './orchestrator-setup.service.js';
