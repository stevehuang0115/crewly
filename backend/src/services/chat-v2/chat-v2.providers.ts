/**
 * Provider factories backing the chat-v2 controller's `/agents` and
 * `/presence/:agentId` endpoints.
 *
 * These are intentionally kept separate from the controller + service so
 * tests can inject a fixture (`IAgentDirectoryProvider` / `IAgentPresenceProvider`
 * stubs) without spinning up StorageService or the orchestrator-status
 * helper. The production wiring in `api.routes.ts` instantiates them
 * once per request stack and passes them as `ChatV2ControllerDeps`.
 *
 * Why a thin adapter layer over StorageService.getTeams + isAgentActive?
 *   - StorageService.getTeams returns the full `Team[]` shape including
 *     fields the directory doesn't need (templates, hierarchy graphs,
 *     project bindings). The controller's `IAgentDirectoryProvider`
 *     contract is intentionally narrow so the route handler stays
 *     decoupled from the storage shape.
 *   - `isAgentActive` returns a boolean only; the controller's wire DTO
 *     wants a `status` union + `lastSeenAt`. We do that mapping here.
 *
 * @module services/chat-v2/chat-v2.providers
 */

import type {
  IAgentDirectoryProvider,
  IAgentPresenceProvider,
  ChatAgentPresenceDTO,
} from '../../controllers/chat-v2/chat-v2.controller.js';

/**
 * Minimal storage surface the providers need. Decoupled from the full
 * `StorageService` so a fixture team list is enough to test.
 */
export interface IStorageServiceLike {
  getTeams(): Promise<
    Array<{
      id: string;
      name: string;
      members: Array<{
        sessionName?: string;
        name: string;
        role: string;
        agentStatus: string;
        workingStatus: string;
        avatar?: string;
      }>;
    }>
  >;
}

/**
 * Minimal agent-liveness probe. Defaults to `isAgentActive` from
 * `orchestrator-status.service`; tests pass a synchronous stub.
 */
export type IsAgentActiveFn = (sessionName: string) => Promise<boolean>;

/**
 * Optional hook for surfacing the virtual "Orchestrator Team". The OSS
 * orchestrator is not a row in any teams.json (it lives in
 * `teams/orchestrator/config.json` and is *filtered out* by
 * StorageService.getTeams), but the user expects to chat with it from
 * the /agents page. The provider synthesizes the team on top of
 * `getTeams()` so the rail always lists the orchestrator first.
 *
 * Tests can override the resolver to return null + skip the virtual
 * team, or to inject a synthetic status without touching storage.
 */
export type OrchestratorStatusResolver = () => Promise<{
  agentStatus: string;
  workingStatus: string;
} | null>;

/**
 * Build the production `IAgentDirectoryProvider`. Flattens
 * `StorageService.getTeams()` into the narrow controller-facing shape,
 * filtering out members without a `sessionName` (incomplete team
 * entries, deleted-but-not-purged rows).
 *
 * Also prepends a synthetic Orchestrator Team so the user can DM the
 * orchestrator from /agents without setting up a regular team. This
 * mirrors team.controller's `buildOrchestratorTeam` virtual-team
 * synthesis on the /api/teams endpoint.
 *
 * @param storage - The StorageService instance (or a fixture stub)
 * @param opts.resolveOrchestratorStatus - Optional override for the
 *   orchestrator's stored status. Defaults to a lazy import of
 *   `StorageService.getOrchestratorStatus()` so tests can inject a stub.
 *   Returning null skips the virtual-team prepend entirely.
 * @returns Provider satisfying {@link IAgentDirectoryProvider}
 */
export function createOssAgentDirectoryProvider(
  storage: IStorageServiceLike,
  opts: {
    resolveOrchestratorStatus?: OrchestratorStatusResolver;
  } = {},
): IAgentDirectoryProvider {
  const resolveOrc =
    opts.resolveOrchestratorStatus ??
    (async () => {
      try {
        // `StorageService.getInstance` is exposed via the same module
        // path used by every other caller (e.g. team.controller). Lazy
        // import keeps the test-only dep optional and avoids a circular
        // resolution when the chat-v2 module loads at boot time.
        const mod = await import('../core/storage.service.js');
        const status = await mod.StorageService.getInstance().getOrchestratorStatus();
        if (!status) return null;
        return {
          agentStatus: status.agentStatus,
          workingStatus: status.workingStatus,
        };
      } catch {
        return null;
      }
    });

  return {
    async getTeams() {
      const teams = await storage.getTeams();
      const flat = teams.map((t) => ({
        id: t.id,
        name: t.name,
        members: t.members
          .filter((m) => typeof m.sessionName === 'string' && m.sessionName.length > 0)
          .map((m) => ({
            sessionName: m.sessionName as string,
            name: m.name,
            role: m.role,
            agentStatus: m.agentStatus,
            workingStatus: m.workingStatus,
            avatar: m.avatar,
          })),
      }));

      const orcStatus = await resolveOrc();
      if (orcStatus) {
        flat.unshift({
          id: 'orchestrator',
          name: 'Orchestrator Team',
          members: [
            {
              sessionName: 'crewly-orc',
              name: 'Orchestrator',
              role: 'orchestrator',
              agentStatus: orcStatus.agentStatus,
              workingStatus: orcStatus.workingStatus,
              avatar: undefined,
            },
          ],
        });
      }
      return flat;
    },
  };
}

/**
 * Map the stored `(agentStatus, workingStatus, isActive)` tuple to the
 * presence wire status. The chat-ui client expects the closed set:
 *   - `online`   : agent is up and idle (ready for a new message)
 *   - `busy`     : agent is up and working on something
 *   - `starting` : agent is registered but session not yet alive
 *   - `offline`  : everything else (inactive, suspended, crash, …)
 *
 * Single source of truth — exported for tests + presence-aware UI bits.
 *
 * @param isActive - True when the PTY/in-process session is alive
 * @param agentStatus - Stored `agentStatus` from team file
 * @param workingStatus - Stored `workingStatus` from team file
 * @returns Wire-level presence status
 */
export function resolvePresenceStatus(
  isActive: boolean,
  agentStatus: string,
  workingStatus: string,
): ChatAgentPresenceDTO['status'] {
  if (!isActive) {
    if (agentStatus === 'starting') return 'starting';
    return 'offline';
  }
  if (workingStatus === 'in_progress') return 'busy';
  return 'online';
}

/**
 * Build the production `IAgentPresenceProvider`. Uses
 * {@link IsAgentActiveFn} (defaulting to `isAgentActive` from
 * orchestrator-status) for liveness and falls back to the stored
 * agentStatus/workingStatus for unknown sessions.
 *
 * @param storage - StorageService for member lookups
 * @param opts.isAgentActive - Optional override (tests pass a stub)
 * @param opts.now - Optional clock override (tests freeze the
 *   `lastSeenAt` timestamp)
 * @returns Provider satisfying {@link IAgentPresenceProvider}
 */
export function createOssAgentPresenceProvider(
  storage: IStorageServiceLike,
  opts: {
    isAgentActive?: IsAgentActiveFn;
    now?: () => number;
  } = {},
): IAgentPresenceProvider {
  const isActiveFn =
    opts.isAgentActive ??
    (async (sessionName: string) => {
      const { isAgentActive } = await import(
        '../orchestrator/orchestrator-status.service.js'
      );
      return isAgentActive(sessionName);
    });
  const now = opts.now ?? Date.now;

  return {
    async getPresence(agentSession: string): Promise<ChatAgentPresenceDTO> {
      let agentStatus = 'inactive';
      let workingStatus = 'idle';
      try {
        const teams = await storage.getTeams();
        for (const team of teams) {
          const member = team.members.find((m) => m.sessionName === agentSession);
          if (member) {
            agentStatus = member.agentStatus;
            workingStatus = member.workingStatus;
            break;
          }
        }
      } catch {
        // Storage failure — treat as offline below. Don't throw; the
        // /presence endpoint should degrade gracefully when the team
        // file is being rewritten under us.
      }

      let active = false;
      try {
        active = await isActiveFn(agentSession);
      } catch {
        active = false;
      }

      return {
        agentSession,
        status: resolvePresenceStatus(active, agentStatus, workingStatus),
        // Only stamp `lastSeenAt` when we have a positive liveness signal.
        // The chat-ui surface treats null as "never seen" / "unknown" and
        // hides the timestamp; offline agents would otherwise show a
        // misleading "last seen just now".
        lastSeenAt: active ? now() : null,
      };
    },
  };
}
