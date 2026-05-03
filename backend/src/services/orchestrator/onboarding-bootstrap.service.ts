/**
 * Onboarding Bootstrap Service (Onboarding v3 — B1).
 *
 * Detects whether a freshly-launched Crewly OSS instance should enter
 * onboarding mode. Two AND-ed signals are required:
 *
 * 1. **Project marker** — `Project.firstLaunchedAt` is unset (or no project
 *    record exists yet). Set on first successful orc bootstrap and never
 *    overwritten thereafter; defends the cold-start signal against the
 *    edge case where chat-v2 is wiped accidentally on an existing install.
 *
 * 2. **Chat-v2 emptiness** — `ChatV2Service.countAllMessages() === 0`.
 *    Captures "user has not spoken to Crewly yet" — Steve's exact phrasing.
 *
 * If EITHER signal says "user has been here before", onboarding does NOT
 * trigger. This intentional belt-and-braces design follows Sam's substrate
 * note 2026-05-03.
 *
 * Hook point: `crewly-agent-runtime.service.initializeInProcess()` calls
 * `shouldEnterOnboardingMode()` before composing the system prompt and
 * branches on the result (B3). After bootstrap success, the orc bootstrap
 * also calls `markProjectAsLaunched()` to set the marker.
 *
 * @module services/orchestrator/onboarding-bootstrap.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { StorageService } from '../core/storage.service.js';
import type { Project } from '../../types/index.js';

/**
 * Minimal contract for the chat-v2 emptiness probe.
 *
 * Decoupled from the concrete `ChatV2Service` so tests can inject a fake
 * counter without bringing up sqlite. Production wiring resolves to
 * `getChatV2Service().countAllMessages.bind(...)`.
 */
export interface ChatMessageCounter {
  /** @returns Total count of persisted chat messages across all channels */
  countAllMessages(): number;
}

/**
 * Constructor dependencies for `OnboardingBootstrapService`.
 */
export interface OnboardingBootstrapDependencies {
  /** Source of project records (provides `getProjects` + `saveProject`). */
  storage: StorageService;
  /** Source of chat-v2 emptiness signal. */
  chat: ChatMessageCounter;
}

/**
 * Cold-start detector for the orchestrator's onboarding mode.
 *
 * The two helpers are called from the orc bootstrap path:
 * - `shouldEnterOnboardingMode()` — branch on this BEFORE composing the
 *   system prompt; if true, load `ONBOARDING_MODE_SYSTEM_PROMPT` instead
 *   of the role prompt.
 * - `markProjectAsLaunched(projectId)` — call AFTER bootstrap succeeds,
 *   regardless of mode, to write the per-project first-launch marker.
 *
 * @example
 * ```typescript
 * const detector = new OnboardingBootstrapService({ storage, chat });
 * if (await detector.shouldEnterOnboardingMode()) {
 *   stateService.setMode('onboarding');
 * }
 * // ... orc init succeeds ...
 * if (currentProjectId) {
 *   await detector.markProjectAsLaunched(currentProjectId);
 * }
 * ```
 */
export class OnboardingBootstrapService {
  private readonly storage: StorageService;
  private readonly chat: ChatMessageCounter;
  private readonly logger: ComponentLogger;

  constructor(deps: OnboardingBootstrapDependencies) {
    this.storage = deps.storage;
    this.chat = deps.chat;
    this.logger = LoggerService.getInstance().createComponentLogger('OnboardingBootstrap');
  }

  /**
   * Decide whether the orchestrator should enter onboarding mode.
   *
   * Both signals must agree on "this is a cold start":
   *
   * 1. The targeted project's `firstLaunchedAt` marker is unset. When
   *    `projectId` is omitted, the check broadens to "no project at all
   *    has the marker set" — appropriate for the orc bootstrap path,
   *    which runs before any user has bound a project.
   * 2. Chat-v2 has zero persisted messages.
   *
   * Errors in either probe are treated as "user has been here before"
   * (returns false) — failing closed avoids false-triggering onboarding
   * on a transient storage hiccup.
   *
   * @param projectId - Optional project to scope the marker check to.
   *   Omit during orc bootstrap (no project context yet).
   * @returns True iff this looks like a fresh OSS install
   */
  async shouldEnterOnboardingMode(projectId?: string): Promise<boolean> {
    // --- Signal 1: project firstLaunchedAt marker ---
    let projectMarkerIsCold: boolean;
    try {
      const projects = await this.storage.getProjects();
      if (projectId !== undefined) {
        const target = projects.find((p) => p.id === projectId);
        // Missing project (deleted under us) and absent marker both count
        // as "cold". Any value (string, even empty string) means the user
        // has been here before — only `undefined` clears the gate.
        projectMarkerIsCold = !target || target.firstLaunchedAt === undefined;
      } else {
        projectMarkerIsCold = !projects.some((p) => p.firstLaunchedAt !== undefined);
      }
    } catch (err) {
      this.logger.warn('Failed to read project marker; failing closed (no onboarding)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (!projectMarkerIsCold) {
      this.logger.debug('Project firstLaunchedAt is set — skipping onboarding', { projectId });
      return false;
    }

    // --- Signal 2: chat-v2 emptiness ---
    let chatIsEmpty: boolean;
    try {
      chatIsEmpty = this.chat.countAllMessages() === 0;
    } catch (err) {
      this.logger.warn('Failed to read chat-v2 count; failing closed (no onboarding)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (!chatIsEmpty) {
      this.logger.debug('Chat-v2 has prior messages — skipping onboarding');
      return false;
    }

    this.logger.info('Cold-start detected — entering onboarding mode', { projectId });
    return true;
  }

  /**
   * Set `firstLaunchedAt` on the named project record.
   *
   * Idempotent: a no-op if the marker is already set (logged at debug),
   * preserving the original launch timestamp. No-op (warn) if the project
   * record cannot be located. Errors are caught and logged so the
   * bootstrap path is not destabilised by a marker-write failure.
   *
   * @param projectId - Target project ID
   */
  async markProjectAsLaunched(projectId: string): Promise<void> {
    try {
      const projects = await this.storage.getProjects();
      const target = projects.find((p) => p.id === projectId);
      if (!target) {
        this.logger.warn('markProjectAsLaunched: project not found', { projectId });
        return;
      }
      if (target.firstLaunchedAt) {
        this.logger.debug('markProjectAsLaunched: marker already set, no-op', {
          projectId,
          existingValue: target.firstLaunchedAt,
        });
        return;
      }

      const now = new Date().toISOString();
      const updated: Project = {
        ...target,
        firstLaunchedAt: now,
        updatedAt: now,
      };
      await this.storage.saveProject(updated);
      this.logger.info('Project marked as launched', { projectId, firstLaunchedAt: now });
    } catch (err) {
      this.logger.error('markProjectAsLaunched: storage write failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor — wired by the bootstrap layer once dependencies exist
// ---------------------------------------------------------------------------

let onboardingBootstrapInstance: OnboardingBootstrapService | null = null;

/**
 * Wire (or replace) the process-wide `OnboardingBootstrapService`.
 *
 * Called once during server bootstrap after `StorageService` and
 * `ChatV2Service` are constructed. Subsequent calls overwrite the binding
 * (used by tests and graceful-restart paths).
 *
 * @param service - The configured service instance
 */
export function setOnboardingBootstrapService(service: OnboardingBootstrapService | null): void {
  onboardingBootstrapInstance = service;
}

/**
 * Resolve the process-wide `OnboardingBootstrapService`.
 *
 * Returns null when not yet wired — callers must tolerate that case
 * (the orc bootstrap path does, because cold-start detection is a "best
 * effort, default to normal mode" probe).
 *
 * @returns The shared service instance, or null if not wired
 */
export function getOnboardingBootstrapService(): OnboardingBootstrapService | null {
  return onboardingBootstrapInstance;
}

/** Reset the singleton — test-only helper. */
export function resetOnboardingBootstrapServiceForTesting(): void {
  onboardingBootstrapInstance = null;
}
