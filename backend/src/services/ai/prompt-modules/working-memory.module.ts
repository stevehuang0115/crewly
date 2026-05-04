/**
 * Working-Memory Wake Card module — injects the "why am I awake right now"
 * card into the agent prompt.
 *
 * Priority 8 — lands after every identity/role/team/skill/memory/team-reference
 * module and after the Mission Card module (priority 7, owned by Leo's
 * dead-code-path fix). This places the wake card as the *freshest* runtime
 * context block the agent reads before it begins acting.
 *
 * The card itself is rendered by {@link WorkingMemoryService}; this module
 * is a thin adapter that:
 *
 * 1. Decides whether to even attempt rendering (`shouldInclude`).
 * 2. Maps {@link ModuleConfig} → {@link WakeCardRequest}.
 * 3. Wraps the service call in a try/catch so any read failure fails soft —
 *    the agent's prompt assembly never breaks because a wake-card lookup
 *    threw. An empty card (no active WorkItem) also collapses to `''`,
 *    causing {@link PromptAssemblyService} to drop the section entirely.
 *
 * Compactable: **false**. The wake card is already hard-capped at
 * `WAKE_CARD_HARD_CAP_BYTES` (≈1.5KB) inside the service. The assembler's
 * 50% trim heuristic would cut the structured "Required next action" /
 * "Known constraints" sections mid-line — the very fields the agent must
 * act on. Better to either keep the full card or drop it via the empty
 * return path.
 *
 * **Architecture note (M2 dead-code-path fix, 2026-05-04):** A previous
 * draft injected the wake card into `PromptGeneratorService.generateMemberPrompt`.
 * That generator is **not** the live runtime prompt builder — every
 * production agent is built through {@link PromptBuilderService} →
 * {@link PromptAssemblyService}. Wiring here is the equivalent location
 * Sam used for the team-leader soul / role-boundaries (P0-1 Phase 2) and
 * the spot Leo's M1 mission-card module (priority 7) re-targets.
 *
 * @module services/ai/prompt-modules/working-memory
 */

import type { PromptModule, ModuleConfig } from './prompt-module.interface.js';
import { WorkingMemoryService } from '../../memory/working-memory.service.js';
import { LoggerService, ComponentLogger } from '../../core/logger.service.js';

/**
 * Token budget for the wake card.
 *
 * The service hard-caps card bytes at `WAKE_CARD_HARD_CAP_BYTES = 1536`.
 * Using ~4 chars/token as the assembler's heuristic: 1536 / 4 ≈ 384.
 * Round up to 400 to leave a small margin for the markdown heading and
 * separators added during assembly.
 */
const WAKE_CARD_MAX_TOKENS = 400;

/**
 * Adapter module that injects the working-memory wake card produced by
 * {@link WorkingMemoryService} into the agent prompt at priority 8.
 *
 * @example
 * ```typescript
 * const mod = new WorkingMemoryModule();
 * if (mod.shouldInclude(config)) {
 *   const card = await mod.build(config);
 *   if (card) prompt += MODULE_SEPARATOR + card;
 * }
 * ```
 */
export class WorkingMemoryModule implements PromptModule {
  name = 'working-memory';
  priority = 8;
  maxTokens = WAKE_CARD_MAX_TOKENS;
  compactable = false;

  private readonly logger: ComponentLogger;

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(
      'WorkingMemoryModule',
    );
  }

  /**
   * Decide whether to call the service at all.
   *
   * Returns false only when the inputs the service strictly needs are
   * missing — `sessionName` (used to filter active WorkItems by target)
   * and at least one of `projectPath` / `projectRoot` (used to load the
   * parent Request JSON from `.crewly/requests/`). For SessionConfig-only
   * legacy callers that drop projectPath, falling back to projectRoot
   * keeps the module operational. When neither is available we skip
   * cleanly rather than send a malformed request to the service.
   *
   * @param config - Module configuration
   * @returns True when the module should attempt to build a wake card
   */
  shouldInclude(config: ModuleConfig): boolean {
    if (!config.sessionName) return false;
    if (!config.projectPath && !config.projectRoot) return false;
    return true;
  }

  /**
   * Build the wake-card section by delegating to {@link WorkingMemoryService}.
   *
   * The service returns the empty string when no signals are available
   * (no active WorkItem assigned to this agent). When that happens this
   * method returns '' too — the assembler then drops the module entry
   * instead of emitting an empty heading.
   *
   * Fail-soft: any thrown error is caught, logged, and converted to ''.
   * `compactable=false` would normally cause the assembler to re-throw
   * unhandled module errors, so swallowing here is required to prevent
   * a wake-card lookup from breaking prompt assembly for the entire agent.
   *
   * @param config - Module configuration
   * @returns The rendered wake card markdown, or '' when nothing to inject
   */
  async build(config: ModuleConfig): Promise<string> {
    const projectPath = config.projectPath ?? config.projectRoot;
    if (!projectPath) {
      // shouldInclude should have caught this, but defend anyway.
      return '';
    }

    try {
      const svc = WorkingMemoryService.getInstance();
      const card = await svc.getWakeCardForAgent({
        // memberId is more stable than sessionName for log correlation;
        // fall back to sessionName when the legacy SessionConfig path
        // omits memberId.
        agentId: config.memberId || config.sessionName,
        sessionName: config.sessionName,
        projectPath,
        teamId: config.teamId,
      });
      return card ?? '';
    } catch (err) {
      this.logger.warn(
        'WorkingMemoryModule build failed — skipping wake card injection',
        {
          sessionName: config.sessionName,
          memberId: config.memberId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return '';
    }
  }
}
