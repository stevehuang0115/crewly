/**
 * Prompt Modules — Modular prompt assembly system.
 *
 * Re-exports all prompt module interfaces, implementations,
 * and assembly services from a single entry point.
 */

// Interface and utilities
export {
	PromptModule,
	ModuleConfig,
	SubordinateInfoCompat,
	ModuleBuildResult,
	AssemblyReport,
	TruncatedModuleInfo,
	estimateTokens,
	loadRoleFragment,
} from './prompt-module.interface.js';

// Prompt modules
export { IdentityModule } from './identity.module.js';
export { SoulModule } from './soul.module.js';
export { SkillsReferenceModule } from './skills-reference.module.js';
export { MemoryReferenceModule } from './memory-reference.module.js';
export { TeamReferenceModule } from './team-reference.module.js';
export { ProjectReferenceModule } from './project-reference.module.js';
export { UserProfileReferenceModule } from './user-profile-reference.module.js';
export { LearningReferenceModule } from './learning-reference.module.js';
export { MissionContextModule } from './mission-context.module.js';
export { SOPNormDistinctionModule } from './sop-norm-distinction.module.js';
export { CommunicationModule } from './communication.module.js';
export { RecoveryModule } from './recovery.module.js';
export { LifecycleModule } from './lifecycle.module.js';
export { RoleBoundaryModule } from './role-boundary.module.js';
export { RequestContractModule } from './request-contract.module.js';
export { DefaultExecutionLoopModule } from './default-execution-loop.module.js';
export { WorkingMemoryModule } from './working-memory.module.js';

// Context loaders
export {
	createScheduledMessagesLoader,
	ScheduledCheckInfo,
	ScheduledChecksProvider,
} from './scheduled-messages.loader.js';

// Assembly services
export { PromptAssemblyService } from './prompt-assembly.service.js';
export { ContextAssemblyService } from './context-assembly.service.js';
