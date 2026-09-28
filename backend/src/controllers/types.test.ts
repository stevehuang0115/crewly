import { describe, it, expect } from '@jest/globals';
import type { ApiContext } from './types.js';
import { StorageService, TmuxService, SchedulerService, MessageSchedulerService } from '../services/index.js';
import { ActiveProjectsService } from '../services/index.js';
import { PromptTemplateService } from '../services/index.js';

describe('Controller Types', () => {
  describe('ApiContext interface', () => {
    it('should accept valid ApiContext with all required services', () => {
      const mockContext: ApiContext = {
        storageService: new StorageService(),
        tmuxService: new TmuxService(),
        schedulerService: {} as SchedulerService,
        activeProjectsService: new ActiveProjectsService(),
        promptTemplateService: new PromptTemplateService(),
        agentRegistrationService: {} as any,
        taskTrackingService: {} as any,
      };

      expect(mockContext.storageService).toBeInstanceOf(StorageService);
      expect(mockContext.tmuxService).toBeInstanceOf(TmuxService);
      expect(mockContext.schedulerService).toBeDefined();
      expect(mockContext.activeProjectsService).toBeInstanceOf(ActiveProjectsService);
      expect(mockContext.promptTemplateService).toBeInstanceOf(PromptTemplateService);
    });

    it('should accept ApiContext with optional messageSchedulerService', () => {
      const mockContextWithScheduler: ApiContext = {
        storageService: new StorageService(),
        tmuxService: new TmuxService(),
        schedulerService: {} as SchedulerService,
        messageSchedulerService: new MessageSchedulerService(new TmuxService(), new StorageService()),
        activeProjectsService: new ActiveProjectsService(),
        promptTemplateService: new PromptTemplateService(),
        agentRegistrationService: {} as any,
        taskTrackingService: {} as any,
      };

      expect(mockContextWithScheduler.messageSchedulerService).toBeInstanceOf(MessageSchedulerService);
    });

    it('should accept ApiContext without optional messageSchedulerService', () => {
      const mockContextWithoutScheduler: ApiContext = {
        storageService: new StorageService(),
        tmuxService: new TmuxService(),
        schedulerService: {} as SchedulerService,
        activeProjectsService: new ActiveProjectsService(),
        promptTemplateService: new PromptTemplateService(),
        agentRegistrationService: {} as any,
        taskTrackingService: {} as any,
      };

      expect(mockContextWithoutScheduler.messageSchedulerService).toBeUndefined();
    });

    it('should have correct property types', () => {
      // This test ensures type compatibility at compile time
      const mockContext: ApiContext = {
        storageService: {} as StorageService,
        tmuxService: {} as TmuxService,
        schedulerService: {} as SchedulerService,
        messageSchedulerService: {} as MessageSchedulerService,
        activeProjectsService: {} as ActiveProjectsService,
        promptTemplateService: {} as PromptTemplateService,
        agentRegistrationService: {} as any,
        taskTrackingService: {} as any,
      };

      // Type assertions to verify interface structure
      expect(typeof mockContext.storageService).toBe('object');
      expect(typeof mockContext.tmuxService).toBe('object');
      expect(typeof mockContext.schedulerService).toBe('object');
      expect(typeof mockContext.messageSchedulerService).toBe('object');
      expect(typeof mockContext.activeProjectsService).toBe('object');
      expect(typeof mockContext.promptTemplateService).toBe('object');
    });

    it('should validate required vs optional properties', () => {
      // Test that messageSchedulerService is truly optional
      const contextWithoutOptional: Omit<ApiContext, 'messageSchedulerService'> = {
        storageService: {} as StorageService,
        tmuxService: {} as TmuxService,
        schedulerService: {} as SchedulerService,
        activeProjectsService: {} as ActiveProjectsService,
        promptTemplateService: {} as PromptTemplateService,
        agentRegistrationService: {} as any,
        taskTrackingService: {} as any,
      };

      // This should be assignable to ApiContext
      const fullContext: ApiContext = contextWithoutOptional;
      expect(fullContext).toBeDefined();
    });
  });

  describe('Type compatibility', () => {
    it('should be compatible with service interfaces', () => {
      // This test verifies that the imported service types are correctly referenced
      const services = {
        storage: StorageService,
        tmux: TmuxService,
        scheduler: SchedulerService,
        messageScheduler: MessageSchedulerService,
        activeProjects: ActiveProjectsService,
        promptTemplate: PromptTemplateService,
      };

      expect(services.storage).toBeDefined();
      expect(services.tmux).toBeDefined();
      expect(services.scheduler).toBeDefined();
      expect(services.messageScheduler).toBeDefined();
      expect(services.activeProjects).toBeDefined();
      expect(services.promptTemplate).toBeDefined();
    });

    it('should maintain import paths consistency', () => {
      // This test ensures that all imported services are properly accessible
      // and that the type definitions match the actual service classes
      expect(StorageService).toBeDefined();
      expect(TmuxService).toBeDefined();
      expect(SchedulerService).toBeDefined();
      expect(MessageSchedulerService).toBeDefined();
      expect(ActiveProjectsService).toBeDefined();
      expect(PromptTemplateService).toBeDefined();
    });
  });
});
