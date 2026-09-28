import type {
  StorageService,
  TmuxService,
  SchedulerService,
  MessageSchedulerService,
  ActiveProjectsService,
  PromptTemplateService,
  AgentRegistrationService,
} from '../services/index.js';

export interface ApiContext {
  storageService: StorageService;
  tmuxService: TmuxService;
  agentRegistrationService: AgentRegistrationService;
  schedulerService: SchedulerService;
  messageSchedulerService?: MessageSchedulerService;
  activeProjectsService: ActiveProjectsService;
  promptTemplateService: PromptTemplateService;
  cleanupProjectScheduledMessages?: (projectId: string) => Promise<{
    found: number;
    cancelled: number;
    errors: string[];
  }>;
}

