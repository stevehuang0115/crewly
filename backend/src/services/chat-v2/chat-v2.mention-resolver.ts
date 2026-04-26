/**
 * ChatV2MentionResolver — turn `mentions[]` from a chat message into a
 * deduplicated list of agent-session dispatch targets.
 *
 * Phase C BE.2 scaffolding for Slack-like team-chat mention dispatch
 * (SEALED §2.1 routing rules):
 *
 *   - **`@agent` mention** (mention id matches a `TeamMember.id`):
 *     resolves to that member's tmux/agent `sessionName`. The dispatcher
 *     will deliver the message directly into that agent's session.
 *
 *   - **`@team` mention** (mention id matches a `Team.id`): resolves to
 *     that team's TL — the canonical primary responder per the spec
 *     ("the Team Lead is the primary responder; if busy, queue in the
 *     Team's Task Pool"). TL is selected as: first member with both
 *     `hierarchyLevel === 1` and `canDelegate === true`, falling back
 *     to any `canDelegate` member, then `members[0]` so the rule is
 *     deterministic even on legacy teams without hierarchy fields.
 *
 *   - **Unknown mention id** (not a team or a known member): skipped
 *     with a debug log. The dispatcher must always succeed even when
 *     the FE includes a stale/typo mention; the chat HTTP ack has
 *     already been sent by the time we resolve.
 *
 * Phase C F2a (issue #333) — cross-tenant scope enforcement: when the
 * caller passes `context.teamId`, the resolver enforces the channel's
 * tenant boundary. `@agent` mentions to members of any other team are
 * dropped (cross-tenant leak vector pinned by Arch on PR #331); `@team`
 * mentions to any team still resolve (cross-team pings are a useful
 * coordination affordance), but a mismatch emits a warn for audit.
 *
 * The resolver is the boundary between the chat-v2 wire (id strings)
 * and the agent runtime (session names). It deliberately does NOT
 * touch the agent registry — it only produces the addresses that the
 * dispatcher will hand to `AgentMessageSink.sendMessageToAgent`.
 *
 * The team list is loaded via an injected `loadTeams()` callback so
 * tests can drive it without a real `StorageService`. Production wiring
 * passes `() => storageService.getTeams()`.
 *
 * @module services/chat-v2/chat-v2.mention-resolver
 */

import type { Team, TeamMember } from '../../types/index.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Kind of mention that resolved to a target. */
export type MentionTargetKind = 'agent' | 'team';

/**
 * One resolved dispatch target. The dispatcher will call
 * `sendMessageToAgent(sessionName, prompt)` for each unique entry.
 */
export interface MentionTarget {
  /** Whether this target came from an `@agent` (member) or `@team` mention. */
  kind: MentionTargetKind;
  /** The original mention id as it appeared in the wire `mentions[]`. */
  mentionId: string;
  /** Resolved member id. For `kind='team'`, this is the TL's member id. */
  memberId: string;
  /** Resolved agent session name — the address `sendMessageToAgent` expects. */
  sessionName: string;
  /** For `kind='team'`, the matched team's id. Undefined for `kind='agent'`. */
  teamId?: string;
}

/** Optional context the resolver may use to disambiguate. */
export interface MentionResolverContext {
  /**
   * The channel's `teamId` (when the channel is `type='channel'`). When set,
   * the resolver enforces cross-tenant scope (Phase C F2a, issue #333):
   *
   *   - `@agent` mentions are restricted to members whose owning team's
   *     id equals `teamId`. Mentions to agents of any other team are
   *     dropped with a debug log so a foreign-team agent never receives
   *     a dispatch frame from a channel they are not a member of.
   *
   *   - `@team` mentions to any team id still resolve to that team's TL
   *     (they remain useful for cross-team coordination), but a mismatch
   *     between the channel's `teamId` and the mentioned team's id emits
   *     a warn so the cross-team ping is observable in audit/log.
   *
   * Leave undefined (or empty string) to disable scoping — used by the
   * legacy DM dispatch path and by tests that need the global resolver.
   */
  teamId?: string;
}

/**
 * Dependencies. The team-list source is callable so tests don't need a
 * StorageService; the production path injects `() => storage.getTeams()`.
 */
export interface MentionResolverDeps {
  /**
   * Returns the current team list. May be sync or async — the resolver
   * awaits the result either way. Errors propagate; the resolver
   * surfaces an empty-target list on caller error so a transient
   * storage hiccup never crashes the chat dispatch path.
   */
  loadTeams: () => Promise<Team[]> | Team[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Stateless resolver — instances are cheap to construct. Each `resolve()`
 * call loads the team list fresh so dispatch always sees the latest
 * member/session bindings (a new agent comes online → next mention
 * resolves correctly without a restart).
 */
export class ChatV2MentionResolver {
  private readonly loadTeams: MentionResolverDeps['loadTeams'];
  private readonly logger: ComponentLogger;

  constructor(deps: MentionResolverDeps) {
    this.loadTeams = deps.loadTeams;
    this.logger = LoggerService.getInstance().createComponentLogger('ChatV2MentionResolver');
  }

  /**
   * Resolve `mentions` to dispatch targets.
   *
   * Behavior:
   *   - Empty / whitespace mention ids are skipped silently.
   *   - Each id is classified as team-first, then agent-first; ties go to
   *     the team interpretation since team ids and member ids share the
   *     same UUID-shape namespace and team mentions are higher-impact.
   *   - Unknown ids are logged at debug level and skipped.
   *   - Duplicate `sessionName`s are collapsed (first-seen wins, keeping
   *     `kind` ordering stable for tests).
   *   - Targets with empty `sessionName` are skipped — there is no agent
   *     to dispatch to.
   *
   * Phase C F2a (#333) — when `context.teamId` is set:
   *   - `@agent` mentions whose owning team !== `context.teamId` are
   *     dropped at debug level (cross-tenant leak guard).
   *   - `@team` mentions to a different team still resolve to that
   *     team's TL but emit a warn so cross-team pings are auditable.
   *   - A blank/whitespace `context.teamId` is treated as "no scope"
   *     so DM dispatch and back-compat tests keep current behavior.
   *
   * @param mentions - The raw mention id list from `ChatMessageDTO.mentions`.
   * @param context - Optional resolver context (teamId etc.).
   * @returns Deduplicated dispatch targets, in input order with team-first ties.
   */
  async resolve(mentions: string[], context?: MentionResolverContext): Promise<MentionTarget[]> {
    if (!Array.isArray(mentions) || mentions.length === 0) {
      return [];
    }

    let teams: Team[];
    try {
      teams = await this.loadTeams();
    } catch (err) {
      this.logger.warn('chat-v2 mention-resolver loadTeams failed; returning no targets', {
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    // Build O(1) lookup maps once per call so even a wide mention array
    // (capped at 50 by the service-layer validator) doesn't cause an
    // O(N*M) team×member scan.
    const teamById = new Map<string, Team>();
    const memberById = new Map<string, { team: Team; member: TeamMember }>();
    for (const team of teams) {
      teamById.set(team.id, team);
      for (const member of team.members ?? []) {
        // First-seen wins on member-id collisions across teams. The
        // legacy data model allows distinct teams to coexist with the
        // same memberId only if both were imported from the same
        // hierarchy backup — which is rare and never a chat path. We
        // log the collision so it surfaces in observability.
        if (memberById.has(member.id)) {
          this.logger.warn('chat-v2 mention-resolver member-id collision across teams', {
            memberId: member.id,
            firstTeamId: memberById.get(member.id)!.team.id,
            secondTeamId: team.id,
          });
          continue;
        }
        memberById.set(member.id, { team, member });
      }
    }

    const results: MentionTarget[] = [];
    const seenSessions = new Set<string>();
    // Treat blank/whitespace teamId as "no scope" so callers don't have to
    // pre-normalize. This matches the channel-rail listing endpoint's
    // teamId filter normalization (see ChatV2Service.listChannels).
    const scopeTeamId =
      typeof context?.teamId === 'string' && context.teamId.trim().length > 0
        ? context.teamId
        : undefined;

    for (const rawId of mentions) {
      if (typeof rawId !== 'string') continue;
      const id = rawId.trim();
      if (id.length === 0) continue;

      // 1) Team-mention takes precedence (higher routing impact).
      const team = teamById.get(id);
      if (team) {
        // F2a (#333): when the channel scopes to a team, a `@team` mention
        // to ANY OTHER team still resolves (deliberate — cross-team pings
        // are a useful coordination affordance), but we emit a warn so
        // operators can audit cross-tenant traffic. No warn on same-team
        // mentions; that's the common case.
        if (scopeTeamId !== undefined && team.id !== scopeTeamId) {
          this.logger.warn('chat-v2 mention-resolver cross-team @team mention', {
            mentionId: id,
            mentionedTeamId: team.id,
            contextTeamId: scopeTeamId,
          });
        }
        const tl = pickTeamLead(team);
        if (!tl) {
          this.logger.debug('chat-v2 mention-resolver team has no dispatchable TL', {
            mentionId: id,
            teamId: team.id,
          });
          continue;
        }
        if (!tl.sessionName) {
          this.logger.debug('chat-v2 mention-resolver TL has empty sessionName', {
            mentionId: id,
            teamId: team.id,
            memberId: tl.id,
          });
          continue;
        }
        if (seenSessions.has(tl.sessionName)) continue;
        seenSessions.add(tl.sessionName);
        results.push({
          kind: 'team',
          mentionId: id,
          memberId: tl.id,
          sessionName: tl.sessionName,
          teamId: team.id,
        });
        continue;
      }

      // 2) Agent (member) mention.
      const hit = memberById.get(id);
      if (hit) {
        // F2a (#333): when the channel scopes to a team, drop @agent
        // mentions whose owning team differs — without this, a
        // type='channel' message in team-A could fan-out to an agent in
        // team-B, the cross-tenant leak vector pinned by Arch on PR #331.
        // The mention silently no-ops at debug level (the chat HTTP ack
        // already returned 200; we don't fail the post for a dropped
        // mention).
        if (scopeTeamId !== undefined && hit.team.id !== scopeTeamId) {
          this.logger.debug('chat-v2 mention-resolver dropping foreign-team @agent', {
            mentionId: id,
            mentionedMemberId: hit.member.id,
            mentionedTeamId: hit.team.id,
            contextTeamId: scopeTeamId,
          });
          continue;
        }
        if (!hit.member.sessionName) {
          this.logger.debug('chat-v2 mention-resolver member has empty sessionName', {
            mentionId: id,
            memberId: hit.member.id,
            teamId: hit.team.id,
          });
          continue;
        }
        if (seenSessions.has(hit.member.sessionName)) continue;
        seenSessions.add(hit.member.sessionName);
        results.push({
          kind: 'agent',
          mentionId: id,
          memberId: hit.member.id,
          sessionName: hit.member.sessionName,
        });
        continue;
      }

      this.logger.debug('chat-v2 mention-resolver unknown mention id', {
        mentionId: id,
        contextTeamId: scopeTeamId,
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Choose the TL (Team Lead) responder for a `@team` mention.
 *
 * Resolution rules (ordered, first match wins):
 *   1. Hierarchy TL: `hierarchyLevel === 1 && canDelegate === true`.
 *   2. Any delegator: `canDelegate === true` regardless of level. Covers
 *      teams that were imported before hierarchy fields were added but
 *      already have a flagged TL.
 *   3. Role-tagged TL: `role === 'team-leader'` so role-based teams that
 *      didn't fill in `canDelegate` still resolve correctly.
 *   4. First member: deterministic last resort — better to dispatch to
 *      _someone_ than silently drop a `@team` ping. Tests cover this
 *      case.
 *
 * Returns `null` only when the team has no members at all.
 *
 * @param team - The matched team.
 * @returns The TL to dispatch to, or null when the team has no members.
 */
function pickTeamLead(team: Team): TeamMember | null {
  const members = team.members ?? [];
  if (members.length === 0) return null;

  return (
    members.find((m) => m.hierarchyLevel === 1 && m.canDelegate === true) ??
    members.find((m) => m.canDelegate === true) ??
    members.find((m) => m.role === 'team-leader') ??
    members[0]
  );
}
