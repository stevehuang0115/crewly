/**
 * Messaging Services Barrel Export
 *
 * @module services/messaging
 */

export { MessageQueueService } from './message-queue.service.js';
export { QueueProcessorService } from './queue-processor.service.js';
export { ResponseRouterService } from './response-router.service.js';
export { ThreadStatusQueueService } from './thread-status-queue.service.js';

import type { MessageQueueService } from './message-queue.service.js';

/** Module-level reference to the message queue instance (set by CrewlyServer on startup). */
let _mqInstance: MessageQueueService | null = null;

/** Store the message queue instance for use by other services (e.g. MessageRouterService). */
export function setMessageQueueInstance(instance: MessageQueueService): void {
  _mqInstance = instance;
}

/** Get the stored message queue instance, or null if not set. */
export function getMessageQueueInstance(): MessageQueueService | null {
  return _mqInstance;
}
