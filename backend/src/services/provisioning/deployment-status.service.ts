/**
 * Deployment Status Service
 *
 * Tracks deployment progress through phases with real-time event emission.
 * Stores deployment history in-memory keyed by deploymentId. Emits events
 * via EventEmitter for real-time status updates (SSE, WebSocket, etc.).
 *
 * @module services/provisioning/deployment-status.service
 */

import { EventEmitter } from 'node:events';

import {
  DeploymentPhase,
  type DeploymentConfig,
  isTerminalPhase,
} from './deployment-orchestrator.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of deployments to keep in history. */
const MAX_DEPLOYMENT_HISTORY = 100;

/** Event name for deployment status updates. */
export const DEPLOYMENT_STATUS_EVENT = 'deployment:status';

/** Event name for deployment completion. */
export const DEPLOYMENT_COMPLETE_EVENT = 'deployment:complete';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single status update entry for a deployment phase. */
export interface DeploymentStatusEntry {
  /** Phase this update relates to. */
  phase: DeploymentPhase;
  /** Human-readable message. */
  message: string;
  /** ISO 8601 timestamp of the update. */
  timestamp: string;
}

/** Full deployment status record. */
export interface DeploymentStatusRecord {
  /** Unique deployment identifier. */
  deploymentId: string;
  /** Current phase. */
  currentPhase: DeploymentPhase;
  /** Whether the deployment has finished (READY or FAILED). */
  isComplete: boolean;
  /** Droplet name from the original config. */
  dropletName: string;
  /** Customer ID if provided. */
  customerId?: string;
  /** Ordered list of status updates. */
  updates: DeploymentStatusEntry[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last update timestamp. */
  updatedAt: string;
}

/** Payload emitted with status events. */
export interface DeploymentStatusEventPayload {
  /** Deployment identifier. */
  deploymentId: string;
  /** Phase that was updated. */
  phase: DeploymentPhase;
  /** Human-readable message. */
  message: string;
  /** Whether the deployment is now complete. */
  isComplete: boolean;
  /** ISO 8601 timestamp. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Tracks and emits real-time deployment status updates.
 *
 * Uses an in-memory Map for storage and Node.js EventEmitter for
 * real-time notifications. Suitable for single-process deployments;
 * for multi-process, back with Redis pub/sub.
 *
 * @example
 * ```typescript
 * const statusService = new DeploymentStatusService();
 *
 * statusService.on(DEPLOYMENT_STATUS_EVENT, (payload) => {
 *   console.log(`[${payload.deploymentId}] ${payload.phase}: ${payload.message}`);
 * });
 *
 * statusService.createDeployment('deploy-1', { dropletName: 'node-1' });
 * statusService.updatePhase('deploy-1', DeploymentPhase.CREATING_DROPLET, 'Creating...');
 * ```
 */
export class DeploymentStatusService extends EventEmitter {
  private readonly deployments: Map<string, DeploymentStatusRecord> = new Map();

  /**
   * Create a new DeploymentStatusService.
   */
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialize tracking for a new deployment.
   *
   * @param deploymentId - Unique deployment identifier
   * @param config - Deployment configuration (for metadata)
   * @returns The created status record
   */
  createDeployment(deploymentId: string, config: Pick<DeploymentConfig, 'dropletName' | 'customerId'>): DeploymentStatusRecord {
    const now = new Date().toISOString();
    const record: DeploymentStatusRecord = {
      deploymentId,
      currentPhase: DeploymentPhase.CREATING_DROPLET,
      isComplete: false,
      dropletName: config.dropletName,
      customerId: config.customerId,
      updates: [{
        phase: DeploymentPhase.CREATING_DROPLET,
        message: 'Deployment initialized',
        timestamp: now,
      }],
      createdAt: now,
      updatedAt: now,
    };

    this.deployments.set(deploymentId, record);
    this.enforceHistoryLimit();

    this.emitStatusEvent(deploymentId, DeploymentPhase.CREATING_DROPLET, 'Deployment initialized', false);

    return record;
  }

  /**
   * Update the phase and status of an existing deployment.
   *
   * @param deploymentId - Deployment identifier
   * @param phase - New deployment phase
   * @param message - Human-readable status message
   * @returns Updated status record, or undefined if deployment not found
   */
  updatePhase(deploymentId: string, phase: DeploymentPhase, message: string): DeploymentStatusRecord | undefined {
    const record = this.deployments.get(deploymentId);
    if (!record) {
      return undefined;
    }

    const now = new Date().toISOString();
    const isComplete = isTerminalPhase(phase);

    record.currentPhase = phase;
    record.isComplete = isComplete;
    record.updatedAt = now;
    record.updates.push({
      phase,
      message,
      timestamp: now,
    });

    this.emitStatusEvent(deploymentId, phase, message, isComplete);

    if (isComplete) {
      this.emit(DEPLOYMENT_COMPLETE_EVENT, { deploymentId, phase, message });
    }

    return record;
  }

  /**
   * Get the current status of a deployment.
   *
   * @param deploymentId - Deployment identifier
   * @returns Status record, or undefined if not found
   */
  getDeploymentStatus(deploymentId: string): DeploymentStatusRecord | undefined {
    return this.deployments.get(deploymentId);
  }

  /**
   * List all tracked deployments, optionally filtered.
   *
   * @param filter - Optional filter criteria
   * @param filter.isComplete - Filter by completion status
   * @param filter.customerId - Filter by customer ID
   * @returns Array of matching deployment status records
   */
  listDeployments(filter?: { isComplete?: boolean; customerId?: string }): DeploymentStatusRecord[] {
    let records = Array.from(this.deployments.values());

    if (filter?.isComplete !== undefined) {
      records = records.filter((r) => r.isComplete === filter.isComplete);
    }
    if (filter?.customerId) {
      records = records.filter((r) => r.customerId === filter.customerId);
    }

    // Return newest first
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Remove a deployment record from the in-memory store.
   *
   * @param deploymentId - Deployment identifier
   * @returns True if the deployment was found and removed
   */
  removeDeployment(deploymentId: string): boolean {
    return this.deployments.delete(deploymentId);
  }

  /**
   * Get the total number of tracked deployments.
   *
   * @returns Count of deployment records
   */
  getDeploymentCount(): number {
    return this.deployments.size;
  }

  /**
   * Clear all deployment records. Useful for testing.
   */
  clearAll(): void {
    this.deployments.clear();
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  /**
   * Emit a status event for real-time listeners.
   *
   * @param deploymentId - Deployment identifier
   * @param phase - Current phase
   * @param message - Status message
   * @param isComplete - Whether the deployment is complete
   */
  private emitStatusEvent(
    deploymentId: string,
    phase: DeploymentPhase,
    message: string,
    isComplete: boolean,
  ): void {
    const payload: DeploymentStatusEventPayload = {
      deploymentId,
      phase,
      message,
      isComplete,
      timestamp: new Date().toISOString(),
    };
    this.emit(DEPLOYMENT_STATUS_EVENT, payload);
  }

  /**
   * Enforce the maximum history limit by removing oldest completed deployments.
   */
  private enforceHistoryLimit(): void {
    if (this.deployments.size <= MAX_DEPLOYMENT_HISTORY) {
      return;
    }

    // Remove oldest completed deployments first
    const sorted = Array.from(this.deployments.entries())
      .filter(([, record]) => record.isComplete)
      .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));

    const toRemove = this.deployments.size - MAX_DEPLOYMENT_HISTORY;
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      this.deployments.delete(sorted[i][0]);
    }
  }
}
