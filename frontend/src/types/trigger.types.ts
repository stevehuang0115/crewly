/**
 * Trigger Type Definitions (Frontend)
 *
 * Mirrors backend v2/trigger.types for use in the Triggers UI.
 *
 * @module types/trigger.types
 */

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

export interface TimeTriggerConfig {
  type: 'time';
  cronExpression?: string;
  timezone?: string;
  delayMs?: number;
  fireAt?: string;
}

export interface SignalTriggerConfig {
  type: 'signal';
  eventType: string;
  filter?: Record<string, unknown>;
}

export interface CompoundTriggerConfig {
  type: 'compound';
  operator: 'and' | 'or';
  conditions: (TimeTriggerConfig | SignalTriggerConfig)[];
}

export type TriggerConfig = TimeTriggerConfig | SignalTriggerConfig | CompoundTriggerConfig;

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export interface TriggerAction {
  createWorkItem?: Record<string, unknown>;
  wakeWorkItemId?: string;
  sendMessage?: { target: string; message: string };
  runReconciler?: boolean;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export type TriggerType = 'time' | 'signal' | 'compound';
export type TriggerStatus = 'active' | 'paused' | 'exhausted' | 'cancelled';

export interface Trigger {
  id: string;
  type: TriggerType;
  config: TriggerConfig;
  action: TriggerAction;
  status: TriggerStatus;
  createdBy: 'user' | 'orchestrator' | 'system' | 'mission';
  createdAt: string;
  lastFiredAt?: string;
  nextFireAt?: string;
  fireCount: number;
  maxFires?: number;
  maxIdleFires: number;
  consecutiveIdleFires: number;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

export interface CreateTriggerInput {
  type: TriggerType;
  config: TriggerConfig;
  action: TriggerAction;
  createdBy: 'user' | 'orchestrator' | 'system' | 'mission';
  maxFires?: number;
  maxIdleFires?: number;
}

// ---------------------------------------------------------------------------
// EventBus Subscription (read-only display in Triggers UI)
// ---------------------------------------------------------------------------

export interface EventSubscription {
  id: string;
  eventType: string;
  filter: Record<string, unknown>;
  oneShot: boolean;
  subscriberSession: string;
  createdAt: string;
  expiresAt?: string;
}

export interface TriggerEngineStatus {
  running: boolean;
  total: number;
  byStatus: Record<TriggerStatus, number>;
  byType: Record<string, number>;
}
