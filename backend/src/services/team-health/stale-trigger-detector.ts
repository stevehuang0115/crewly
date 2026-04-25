/**
 * Stale-Trigger Detector — §B.4 implementation
 *
 * Pure function. Identifies WorkItems whose stated work has no source-of-
 * truth basis. Returns a SUSPICION SCORE via Set<workItemId>; the watchdog
 * action is to ask the assignee to confirm cancel — auto-cancel stays in
 * Reconciler.
 *
 * @module services/team-health/stale-trigger-detector
 */

import type { WorkItem } from '../../types/v2/index.js';
import type {
  ArtifactProbeResult,
  StaleTriggerConfig,
} from './team-health-types.js';

export interface StaleTriggerInput {
  priorDoneCounts?: Map<string, number>;
  artifactProbes?: Map<string, ArtifactProbeResult[]>;
}

/**
 * Identify the set of WorkItem IDs flagged stale per §B.4.
 *
 * @param workItems - All active WorkItems being evaluated
 * @param input - Optional pre-computed signals (data provider supplies)
 * @param config - Detection config
 * @returns Set of WorkItem IDs flagged stale
 */
export function detectStaleWorkItems(
  workItems: WorkItem[],
  input: StaleTriggerInput,
  config: StaleTriggerConfig,
): Set<string> {
  const out = new Set<string>();
  if (!config.enabled) return out;
  for (const wi of workItems) {
    if (isStale(wi, input, config)) out.add(wi.id);
  }
  return out;
}

/**
 * Test whether a single WorkItem is stale.
 *
 * @param wi - WorkItem under inspection
 * @param input - Pre-computed prior-done counts and artifact probes
 * @param config - Detection config
 * @returns true if any stale-fire condition matches
 */
export function isStale(
  wi: WorkItem,
  input: StaleTriggerInput,
  config: StaleTriggerConfig,
): boolean {
  if (wi.status === 'done' || wi.status === 'verified' || wi.status === 'cancelled') {
    return false;
  }
  const priorCount = input.priorDoneCounts?.get(wi.id) ?? 0;
  if (priorCount >= config.minPriorDoneCountForRedundancy) return true;
  const probes = input.artifactProbes?.get(wi.id) ?? [];
  for (const p of probes) if (p.isStale) return true;
  return false;
}

/**
 * Build a human-readable evidence string for one WorkItem.
 *
 * @param wi - The WorkItem
 * @param input - Pre-computed signals
 * @param config - Detection config
 * @returns Multi-line evidence string; empty if no stale signal
 */
export function describeStaleEvidence(
  wi: WorkItem,
  input: StaleTriggerInput,
  config: StaleTriggerConfig,
): string {
  const lines: string[] = [];
  const priorCount = input.priorDoneCounts?.get(wi.id) ?? 0;
  if (priorCount >= config.minPriorDoneCountForRedundancy) {
    lines.push(
      `• ${priorCount} prior done tasks with overlapping AC ` +
        `(threshold: ${config.minPriorDoneCountForRedundancy}).`,
    );
  }
  const probes = input.artifactProbes?.get(wi.id) ?? [];
  for (const p of probes) {
    if (!p.isStale) continue;
    lines.push(`• ${labelKind(p.kind)}: ${p.evidence}`);
  }
  return lines.join('\n');
}

function labelKind(kind: ArtifactProbeResult['kind']): string {
  switch (kind) {
    case 'package_version': return 'package.json version mismatch';
    case 'prior_done_count': return 'prior done tasks';
    case 'route': return 'route reference';
    case 'migration': return 'migration reference';
    case 'file_state': return 'file already in target state';
    default: return 'artifact probe';
  }
}
