/**
 * OSS team-membership validator for `ChatV2Service.validateTeamMembership`.
 *
 * Phase C F2b (issue #333) — outer-ring tenant defense for type='channel'
 * channel creation. The chat service's optional `validateTeamMembership`
 * dependency is invoked when a caller binds a channel to a `teamId`; if
 * the principal is not authorized for that team, the service throws
 * `forbidden_team` (HTTP 403) before persisting the row.
 *
 * In OSS single-user mode there is no per-user tenant binding — the
 * single user owns every team in their workspace. The right semantic is
 * therefore "the team must exist" (you cannot bind a channel to a team
 * id you fabricated). Cloud Portal Phase E swaps in a tenant-aware
 * validator that checks the user's tenant membership against the team's
 * tenant.
 *
 * Implementation: `existsSync` of `<teamsDir>/<teamId>/config.json`. Sync
 * by design — `ChatV2Service.createChannel` runs inside the synchronous
 * `runHandler` controller wrapper. Async refactors are a Phase E concern.
 *
 * @module services/chat-v2/chat-v2.team-membership
 */

import { existsSync } from 'fs';
import * as path from 'path';
import { StorageService } from '../core/storage.service.js';
import type { ChatPrincipal } from './types.js';

/**
 * Build the OSS validator. Captures the StorageService instance lazily so
 * the singleton resolves correctly even when `getInstance()` lands later
 * in module-init order (matches the existing `loadTeams` injection
 * pattern in chat-v2 wiring).
 *
 * @param deps - Optional dependency overrides for tests.
 * @returns A sync validator suitable for `ChatV2ServiceOptions.validateTeamMembership`.
 *
 * @example
 *   const validator = createOssTeamMembershipValidator();
 *   const service = getChatV2Service({ validateTeamMembership: validator });
 */
export function createOssTeamMembershipValidator(
  deps: {
    /** Resolves the per-team config dir. Defaults to StorageService singleton. */
    getTeamDir?: (teamId: string) => string;
    /** Existence check. Override in tests to avoid touching the real FS. */
    fileExists?: (filePath: string) => boolean;
  } = {},
): (principal: ChatPrincipal, teamId: string) => boolean {
  const getTeamDir =
    deps.getTeamDir ??
    ((teamId: string) => StorageService.getInstance().getTeamDir(teamId));
  const fileExists = deps.fileExists ?? existsSync;

  return (_principal: ChatPrincipal, teamId: string): boolean => {
    // Defensive: a blank teamId never points to a real team. The service
    // already rejects with VALIDATION before reaching the validator, so
    // this is belt-and-suspenders.
    if (typeof teamId !== 'string' || teamId.trim().length === 0) {
      return false;
    }
    const configPath = path.join(getTeamDir(teamId), 'config.json');
    return fileExists(configPath);
  };
}
