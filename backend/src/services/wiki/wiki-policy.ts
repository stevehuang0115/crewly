/**
 * Write-policy decisions for a vault (SCHEMA.md `write_policy`).
 *
 * Who wrote is resolved by the server from the `X-Agent-Session` header
 * (session → team member → role), never from a role the caller claims.
 * The owner (dashboard, no session) and the orchestrator are canonical.
 *
 * @module services/wiki/wiki-policy
 */

import type { VaultSchema } from './wiki.types.js';

/** What a write by a given role becomes. */
export type WriteDecision = 'canonical' | 'proposed';

/**
 * Decide whether a writer's page lands directly or as a proposal.
 *
 * Rules, in order: no role (owner/UI) → canonical; role listed in
 * `canonical` → canonical; role listed in `proposed_only` → proposed;
 * `worker` in `proposed_only` covers every role not listed elsewhere;
 * an unlisted role with no `worker` catch-all → proposed (safe default).
 *
 * @param schema - Vault schema
 * @param role - Writer's role (lower-cased inside), or undefined for the owner
 * @returns The decision
 */
export function decideWrite(schema: Pick<VaultSchema, 'write_policy'>, role: string | undefined): WriteDecision {
  if (!role) return 'canonical';
  const r = role.toLowerCase();
  if (r === 'orchestrator' || r === 'owner') return 'canonical';
  const canonical = schema.write_policy.canonical.map((x) => x.toLowerCase());
  if (canonical.includes(r)) return 'canonical';
  return 'proposed';
}

/**
 * Whether a role may accept/reject proposals or supersede pages (a
 * canonical role).
 *
 * @param schema - Vault schema
 * @param role - Role, or undefined for the owner
 * @returns True when allowed
 */
export function canReview(schema: Pick<VaultSchema, 'write_policy'>, role: string | undefined): boolean {
  return decideWrite(schema, role) === 'canonical';
}
