import { EventEmitter } from 'events';
import { ScheduledMessage, MessageDeliveryLog } from '../../types/index.js';
import { TmuxService } from '../agent/tmux.service.js';
import { AgentRegistrationService } from '../agent/agent-registration.service.js';
import { StorageService } from '../core/storage.service.js';
import { LoggerService } from '../core/logger.service.js';
import { MessageDeliveryLogModel } from '../../models/ScheduledMessage.js';
import { CREWLY_CONSTANTS, RUNTIME_TYPES, ORCHESTRATOR_SESSION_NAME, RuntimeType } from '../../constants.js';
import { effectiveRuntimeType } from '../runtime-fallback/effective-runtime.js';

export class MessageSchedulerService extends EventEmitter {
  private activeTimers: Map<string, NodeJS.Timeout> = new Map();
  private _legacyTmuxService: TmuxService; // DORMANT: kept for backward compatibility
  private storageService: StorageService;
  private agentRegistrationService: AgentRegistrationService | null = null;
  private logger = LoggerService.getInstance().createComponentLogger('MessageSchedulerService');
  private messageQueue: Array<{ message: ScheduledMessage; resolve: () => void; reject: (error: Error) => void }> = [];
  private isProcessingQueue = false;

  constructor(tmuxService: TmuxService, storageService: StorageService) {
    super();
    this._legacyTmuxService = tmuxService; // DORMANT: kept for backward compatibility
    this.storageService = storageService;
  }

  /**
   * Set the AgentRegistrationService for reliable message delivery.
   * Called after both services are constructed to avoid circular dependencies.
   *
   * @param service - The AgentRegistrationService instance
   */
  setAgentRegistrationService(service: AgentRegistrationService): void {
    this.agentRegistrationService = service;
  }

  /**
   * Start the scheduler - load all active messages and schedule them
   */
  async start(): Promise<void> {
    this.logger.info('Starting message scheduler service...');
    await this.loadAndScheduleAllMessages();
    this.logger.info('Message scheduler service started');
  }

  /**
   * Schedule a new message
   */
  scheduleMessage(message: ScheduledMessage): void {
    if (!message.isActive) {
      return;
    }

    this.cancelMessage(message.id); // Cancel existing if any

    const delayMs = this.getDelayInMilliseconds(message.delayAmount, message.delayUnit);

    const executeMessage = async () => {
      // Route ALL messages through sequential queue to prevent race conditions
      await this.executeMessageSequentially(message);

      if (message.isRecurring && message.isActive) {
        // Schedule next execution for recurring messages
        const timer = setTimeout(executeMessage, delayMs);
        this.activeTimers.set(message.id, timer);
      } else {
        // Remove from active timers for one-time messages
        this.activeTimers.delete(message.id);
      }
    };

    const timer = setTimeout(executeMessage, delayMs);
    this.activeTimers.set(message.id, timer);

    const contextInfo = message.targetProject ? ` for project ${message.targetProject}` : '';
    this.logger.info('Scheduled message', {
      name: message.name,
      targetProject: message.targetProject || undefined,
      delay: `${message.delayAmount} ${message.delayUnit}`,
      recurring: message.isRecurring
    });
  }

  /**
   * Cancel a scheduled message
   */
  cancelMessage(messageId: string): void {
    const timer = this.activeTimers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(messageId);
      this.logger.info('Cancelled scheduled message', { messageId });
    }
  }

  /**
   * Reschedule all active messages (used when messages are updated)
   */
  async rescheduleAllMessages(): Promise<void> {
    this.logger.info('Rescheduling all messages...');
    this.cancelAllMessages();
    await this.loadAndScheduleAllMessages();
  }

  /**
   * Cancel all scheduled messages
   */
  cancelAllMessages(): void {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.logger.info('Cancelled all scheduled messages');
  }

  /**
   * Get statistics about active schedules
   */
  getStats(): {
    activeSchedules: number;
    scheduledMessageIds: string[];
  } {
    return {
      activeSchedules: this.activeTimers.size,
      scheduledMessageIds: Array.from(this.activeTimers.keys())
    };
  }

  /**
   * Resolve the runtime type for a target session by looking up the team member.
   * Falls back to claude-code if the member is not found.
   *
   * @param sessionName - The session name to look up
   * @returns The runtime type for the session
   */
  private async resolveRuntimeType(sessionName: string): Promise<RuntimeType> {
    try {
      // Check orchestrator status first (orchestrator is not a team member)
      if (sessionName === ORCHESTRATOR_SESSION_NAME) {
        const orchestratorStatus = await this.storageService.getOrchestratorStatus();
        if (orchestratorStatus?.runtimeType) {
          return effectiveRuntimeType(sessionName, orchestratorStatus.runtimeType as RuntimeType);
        }
      }

      const memberInfo = await this.storageService.findMemberBySessionName(sessionName);
      if (memberInfo?.member?.runtimeType) {
        return effectiveRuntimeType(sessionName, memberInfo.member.runtimeType as RuntimeType);
      }
    } catch (err) {
      this.logger.debug('Could not resolve runtime type, using default', {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return RUNTIME_TYPES.CLAUDE_CODE;
  }

  /**
   * Execute a scheduled message using reliable delivery via AgentRegistrationService.
   * Falls back to fire-and-forget if AgentRegistrationService is not available.
   */
  private async executeMessage(message: ScheduledMessage): Promise<void> {
    let success = false;
    let error: string | undefined;
    let enhancedMessage = message.message;
    let shouldDeactivateMessage = false;

    try {
      // Validate project exists if message targets a specific project
      if (message.targetProject) {
        const projectExists = await this.validateProjectExists(message.targetProject);
        if (!projectExists) {
          shouldDeactivateMessage = true;
          throw new Error(`Target project "${message.targetProject}" no longer exists - deactivating message`);
        }
      }

      // Determine target session name
      const sessionName = message.targetTeam === 'orchestrator'
        ? CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME
        : message.targetTeam;

      // Enhance message with continuation instructions to handle interruptions gracefully
      enhancedMessage = this.addContinuationInstructions(message.message);

      if (this.agentRegistrationService) {
        // Reliable delivery path: uses retry + progressive verification + background scanner
        const runtimeType = await this.resolveRuntimeType(sessionName);
        const deliveryResult = await this.agentRegistrationService.sendMessageToAgent(
          sessionName,
          enhancedMessage,
          runtimeType
        );
        success = deliveryResult.success;
        if (!success) {
          throw new Error(deliveryResult.error || 'Delivery failed after retries');
        }
      } else {
        // Fallback: should not happen in normal operation, but keeps backward compatibility
        this.logger.warn('AgentRegistrationService not available, using fallback delivery', {
          name: message.name,
        });

        // Check runtime type — in-process runtimes (crewly-agent) cannot be reached via PTY fallback
        const runtimeType = await this.resolveRuntimeType(sessionName);
        if (runtimeType === RUNTIME_TYPES.CREWLY_AGENT) {
          throw new Error(
            `Cannot deliver scheduled message to in-process agent '${sessionName}' without AgentRegistrationService. ` +
            `Crewly Agent runtime requires AgentRegistrationService for message delivery.`
          );
        }

        const { getSessionBackendSync } = await import('../session/index.js');
        const { SessionCommandHelper } = await import('../session/session-command-helper.js');
        const backend = getSessionBackendSync();
        if (!backend) {
          throw new Error('Session backend not initialized');
        }
        const commandHelper = new SessionCommandHelper(backend);
        if (!commandHelper.sessionExists(sessionName)) {
          throw new Error(`Target session "${sessionName}" does not exist`);
        }
        await commandHelper.sendMessage(sessionName, enhancedMessage);
        success = true;
      }

      this.logger.info('Executed scheduled message', {
        name: message.name,
        targetTeam: message.targetTeam,
        targetProject: message.targetProject || undefined
      });

    } catch (sendError) {
      success = false;
      error = sendError instanceof Error ? sendError.message : 'Failed to send message';

      if (shouldDeactivateMessage) {
        this.logger.warn('Deactivating orphaned scheduled message', { name: message.name, error });
      } else {
        this.logger.error('Error executing scheduled message', { name: message.name, error });
      }
    }

    // Create delivery log
    const deliveryLog = MessageDeliveryLogModel.create({
      scheduledMessageId: message.id,
      messageName: message.name,
      targetTeam: message.targetTeam,
      targetProject: message.targetProject,
      message: enhancedMessage,
      success,
      error
    });

    try {
      await this.storageService.saveDeliveryLog(deliveryLog);
    } catch (logError) {
      this.logger.error('Error saving delivery log', { error: logError instanceof Error ? logError.message : String(logError) });
    }

    // Update last run time and deactivate if one-off message or orphaned
    try {
      const updatedMessage = {
        ...message,
        lastRun: new Date().toISOString(),
        // Deactivate one-off messages after execution OR orphaned messages
        isActive: message.isRecurring && !shouldDeactivateMessage ? message.isActive : false,
        updatedAt: new Date().toISOString()
      };
      await this.storageService.saveScheduledMessage(updatedMessage);

      // If message was deactivated, cancel its timer
      if (!updatedMessage.isActive) {
        this.cancelMessage(message.id);

        if (shouldDeactivateMessage) {
          this.logger.info('Orphaned message has been deactivated and removed from scheduler', { name: message.name });
        } else if (!message.isRecurring) {
          this.logger.info('One-off message has been deactivated after execution', { name: message.name });
        }
      }
    } catch (updateError) {
      this.logger.error('Error updating message last run time', { error: updateError instanceof Error ? updateError.message : String(updateError) });
    }

    // Emit event for monitoring
    this.emit('message_executed', {
      message,
      deliveryLog,
      success
    });
  }

  /**
   * Execute message through sequential queue to prevent race conditions between simultaneous messages
   */
  private async executeMessageSequentially(message: ScheduledMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      // Add message to queue
      this.messageQueue.push({ message, resolve, reject });

      // Start processing queue if not already processing
      if (!this.isProcessingQueue) {
        this.processMessageQueue();
      }
    });
  }

  /**
   * Process the message queue sequentially
   */
  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return; // Already processing
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const queueItem = this.messageQueue.shift();
      if (!queueItem) continue;

      const { message, resolve, reject } = queueItem;

      try {
        // Log queue processing for all scheduled messages
        this.logger.info('Processing scheduled message', {
          name: message.name,
          targetProject: message.targetProject || undefined,
          queueLength: this.messageQueue.length
        });

        // Execute the message
        await this.executeMessage(message);

        // Wait a short delay between executions to prevent overwhelming the system and race conditions
        await new Promise(resolve => setTimeout(resolve, 1000));

        resolve();
      } catch (error) {
        this.logger.error('Error processing queued message', { name: message.name, error: error instanceof Error ? error.message : String(error) });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.isProcessingQueue = false;
    this.logger.info('Finished processing message queue');
  }

  /**
   * Load all active messages from storage and schedule them
   */
  private async loadAndScheduleAllMessages(): Promise<void> {
    try {
      const messages = await this.storageService.getScheduledMessages();
      const activeMessages = messages.filter(msg => msg.isActive);

      this.logger.info('Found active scheduled messages to schedule', { count: activeMessages.length });

      for (const message of activeMessages) {
        this.scheduleMessage(message);
      }
    } catch (error) {
      this.logger.error('Error loading scheduled messages', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Convert delay amount and unit to milliseconds
   */
  private getDelayInMilliseconds(amount: number, unit: 'seconds' | 'minutes' | 'hours'): number {
    switch (unit) {
      case 'seconds':
        return amount * 1000;
      case 'minutes':
        return amount * 60 * 1000;
      case 'hours':
        return amount * 60 * 60 * 1000;
      default:
        throw new Error(`Invalid delay unit: ${unit}`);
    }
  }

  /**
   * Validate that a project still exists in the system
   */
  private async validateProjectExists(projectId: string): Promise<boolean> {
    try {
      const projects = await this.storageService.getProjects();
      return projects.some(project => project.id === projectId);
    } catch (error) {
      this.logger.error('Error validating project existence', { error: error instanceof Error ? error.message : String(error) });
      return false; // Assume project doesn't exist if we can't verify
    }
  }

  /**
   * Add continuation instructions to scheduled messages to handle interruptions gracefully
   */
  private addContinuationInstructions(originalMessage: string): string {
    return `🔄 [SCHEDULED CHECK-IN - Please continue previous work after this]

${originalMessage}

⚡ IMPORTANT: After responding to this check-in, IMMEDIATELY CONTINUE your previous work without waiting for further instructions. If you were implementing, coding, testing, or working on any task when this message arrived, resume that exact work now. Do not stop your development workflow - this is just a quick status update. Continue where you left off.`;
  }

  /**
   * Clean up orphaned scheduled messages for non-existent projects
   */
  async cleanupOrphanedMessages(): Promise<{
    found: number;
    deactivated: number;
    errors: string[];
  }> {
    const result = {
      found: 0,
      deactivated: 0,
      errors: [] as string[]
    };

    try {
      this.logger.info('Starting orphaned message cleanup...');

      const messages = await this.storageService.getScheduledMessages();
      const projectMessages = messages.filter(msg => msg.targetProject && msg.isActive);

      result.found = projectMessages.length;
      this.logger.info('Found project-targeted messages to validate', { count: result.found });

      if (result.found === 0) {
        this.logger.info('No project-targeted messages found');
        return result;
      }

      // Get all existing projects for validation
      const projects = await this.storageService.getProjects();
      const projectIds = new Set(projects.map(p => p.id));

      for (const message of projectMessages) {
        try {
          if (!projectIds.has(message.targetProject!)) {
            this.logger.info('Deactivating orphaned message for non-existent project', {
              name: message.name,
              targetProject: message.targetProject
            });

            // Deactivate the message
            const updatedMessage = {
              ...message,
              isActive: false,
              updatedAt: new Date().toISOString()
            };

            await this.storageService.saveScheduledMessage(updatedMessage);
            this.cancelMessage(message.id);

            result.deactivated++;
          }
        } catch (error) {
          const errorMsg = `Failed to process message ${message.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          result.errors.push(errorMsg);
          this.logger.error('Failed to process message during cleanup', { messageId: message.id, error: error instanceof Error ? error.message : String(error) });
        }
      }

      this.logger.info('Orphaned message cleanup complete', { deactivated: result.deactivated, total: result.found });

      if (result.errors.length > 0) {
        this.logger.warn('Errors occurred during cleanup', { errorCount: result.errors.length });
      }

    } catch (error) {
      const errorMsg = `Failed to cleanup orphaned messages: ${error instanceof Error ? error.message : 'Unknown error'}`;
      result.errors.push(errorMsg);
      this.logger.error('Failed to cleanup orphaned messages', { error: error instanceof Error ? error.message : String(error) });
    }

    return result;
  }

  /**
   * Clean up all timers
   */
  cleanup(): void {
    this.cancelAllMessages();
    this.logger.info('Message scheduler service cleaned up');
  }
}
