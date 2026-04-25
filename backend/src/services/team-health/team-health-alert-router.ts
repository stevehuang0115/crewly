/**
 * Team-Health-Watchdog (THW) — Alert Router
 *
 * §D (dedup + cooldown ladder) and §H.2 (channel routing). Holds in-memory
 * cooldown / alert-budget state. The watchdog service owns Slack delivery;
 * this router decides what to send, to whom, and whether to suppress.
 *
 * Layer-4 invariant (§A.1): NEVER mutates lower-layer state.
 *
 * @module services/team-health/team-health-alert-router
 */

import type {
  AlertChannel,
  AlertDecision,
  OffHoursConfig,
  TeamHealthAlertingConfig,
  TeamHealthDetection,
  TeamSummary,
  VerdictCode,
} from './team-health-types.js';
import { VERDICT_DISPLAY } from './team-health-types.js';

interface CooldownEntry {
  teamId: string;
  verdict: VerdictCode;
  bucket: number;
  postedAt: number;
}

interface BudgetEntry {
  count: number;
  windowStart: number;
}

type SilenceMap = Map<string, number>;

/**
 * Routes detections to alert decisions (channel + message + suppress
 * reason). State persists in memory; the watchdog can snapshot/restore
 * across restarts via the sidecar JSON files (§F.2).
 */
export class TeamHealthAlertRouter {
  private cooldowns = new Map<string, CooldownEntry>();
  private budgets = new Map<string, BudgetEntry>();
  private silenced: SilenceMap = new Map();

  constructor(
    private alertingConfig: TeamHealthAlertingConfig,
    private offHoursConfig: OffHoursConfig,
    private shadowMode: boolean,
  ) {}

  setShadowMode(shadowMode: boolean): void {
    this.shadowMode = shadowMode;
  }

  reconfigure(alerting: TeamHealthAlertingConfig, offHours: OffHoursConfig): void {
    this.alertingConfig = alerting;
    this.offHoursConfig = offHours;
  }

  silenceTeam(teamId: string, now: Date, durationMs: number): void {
    this.silenced.set(teamId, now.getTime() + durationMs);
  }

  snapshotState(): {
    cooldowns: CooldownEntry[];
    budgets: { teamId: string; count: number; windowStart: number }[];
    silenced: { teamId: string; until: number }[];
  } {
    return {
      cooldowns: Array.from(this.cooldowns.values()),
      budgets: Array.from(this.budgets.entries()).map(([teamId, b]) => ({
        teamId, count: b.count, windowStart: b.windowStart,
      })),
      silenced: Array.from(this.silenced.entries()).map(([teamId, until]) => ({
        teamId, until,
      })),
    };
  }

  restoreState(snapshot: ReturnType<TeamHealthAlertRouter['snapshotState']>): void {
    this.cooldowns.clear();
    for (const e of snapshot.cooldowns) {
      this.cooldowns.set(`${e.teamId}|${e.verdict}`, e);
    }
    this.budgets.clear();
    for (const b of snapshot.budgets) {
      this.budgets.set(b.teamId, { count: b.count, windowStart: b.windowStart });
    }
    this.silenced.clear();
    for (const s of snapshot.silenced) {
      this.silenced.set(s.teamId, s.until);
    }
  }

  /**
   * Route one detection to an AlertDecision. Idempotent: caller iterates
   * over a batch without ordering side-effects. Cooldown commits happen
   * only via `commitDecision`.
   *
   * @param detection - Detection from the detector
   * @param team - Team summary (slack thread/TL routing)
   * @param now - Current wall-clock time
   * @param systemOrphanTotal - System-wide orphan count for ops escalation
   */
  route(
    detection: TeamHealthDetection,
    team: TeamSummary,
    now: Date,
    systemOrphanTotal: number,
  ): AlertDecision {
    const baseDedupKey = `${detection.teamId}|${detection.verdict}`;
    const effectiveVerdict = this.applyOffHoursDowngrade(detection.verdict, now);

    if (effectiveVerdict === 'healthy') {
      const hadAlerts = this.dropCooldownsForTeam(detection.teamId);
      return {
        detection,
        channel: hadAlerts ? 'team-thread' : 'suppressed',
        effectiveVerdict,
        message: hadAlerts
          ? formatRecoveryMessage(team, detection, now)
          : formatHealthyNoOp(team, detection),
        suppressionReason: hadAlerts ? undefined : 'stable_healthy',
        dedupKey: baseDedupKey,
      };
    }

    const silenceUntil = this.silenced.get(detection.teamId);
    if (silenceUntil && silenceUntil > now.getTime()) {
      return {
        detection, channel: 'suppressed', effectiveVerdict, message: '',
        suppressionReason: 'silenced_by_react', dedupKey: baseDedupKey,
      };
    }

    if (this.shadowMode) {
      return {
        detection, channel: 'suppressed', effectiveVerdict,
        message: formatRollupMessage(detection, team, effectiveVerdict, systemOrphanTotal),
        suppressionReason: 'shadow_mode', dedupKey: baseDedupKey,
      };
    }

    const cooldownMs = this.cooldownForVerdict(effectiveVerdict);
    const bucket = Math.floor(now.getTime() / cooldownMs);
    const existing = this.cooldowns.get(baseDedupKey);
    if (existing && existing.bucket === bucket) {
      return {
        detection, channel: 'suppressed', effectiveVerdict, message: '',
        suppressionReason: 'cooldown', dedupKey: baseDedupKey,
      };
    }

    if (this.budgetExceeded(detection.teamId, now)) {
      return {
        detection, channel: 'suppressed', effectiveVerdict, message: '',
        suppressionReason: 'alert_budget_exceeded', dedupKey: baseDedupKey,
      };
    }

    return {
      detection,
      channel: this.channelForVerdict(effectiveVerdict, team),
      effectiveVerdict,
      message: formatRollupMessage(detection, team, effectiveVerdict, systemOrphanTotal),
      dedupKey: baseDedupKey,
    };
  }

  /**
   * Acknowledge a delivered alert: bumps cooldown bucket + budget counter.
   * Suppressed decisions do NOT call this — they have no side-effects.
   */
  commitDecision(decision: AlertDecision, now: Date): void {
    if (decision.channel === 'suppressed') return;
    if (decision.effectiveVerdict === 'healthy') return;
    const cooldownMs = this.cooldownForVerdict(decision.effectiveVerdict);
    const bucket = Math.floor(now.getTime() / cooldownMs);
    this.cooldowns.set(decision.dedupKey, {
      teamId: decision.detection.teamId,
      verdict: decision.effectiveVerdict,
      bucket, postedAt: now.getTime(),
    });
    this.bumpBudget(decision.detection.teamId, now);
  }

  private cooldownForVerdict(v: VerdictCode): number {
    switch (v) {
      case 'cascade': return this.alertingConfig.cascadeCooldownMs;
      case 'stuck': return this.alertingConfig.redCooldownMs;
      case 'stalling':
      case 'stale':
      default: return this.alertingConfig.yellowCooldownMs;
    }
  }

  private channelForVerdict(v: VerdictCode, team: TeamSummary): AlertChannel {
    if (v === 'cascade') return 'ops-channel';
    return team.slackThreadId ? 'team-thread' : 'tl-dm';
  }

  private applyOffHoursDowngrade(v: VerdictCode, now: Date): VerdictCode {
    if (!this.offHoursConfig.enabled) return v;
    if (v !== 'stuck') return v;
    if (isWithinWorkingHours(now, this.offHoursConfig)) return v;
    return 'stalling';
  }

  private dropCooldownsForTeam(teamId: string): boolean {
    let droppedAny = false;
    for (const key of Array.from(this.cooldowns.keys())) {
      const entry = this.cooldowns.get(key);
      if (entry && entry.teamId === teamId) {
        this.cooldowns.delete(key);
        droppedAny = true;
      }
    }
    return droppedAny;
  }

  private budgetExceeded(teamId: string, now: Date): boolean {
    const budget = this.budgets.get(teamId);
    if (!budget) return false;
    const windowEnd = budget.windowStart + this.alertingConfig.alertBudgetWindowMs;
    if (now.getTime() > windowEnd) {
      this.budgets.delete(teamId);
      return false;
    }
    return budget.count >= this.alertingConfig.alertBudgetMaxAlertsPerTeam;
  }

  private bumpBudget(teamId: string, now: Date): void {
    const existing = this.budgets.get(teamId);
    if (!existing) {
      this.budgets.set(teamId, { count: 1, windowStart: now.getTime() });
      return;
    }
    const windowEnd = existing.windowStart + this.alertingConfig.alertBudgetWindowMs;
    if (now.getTime() > windowEnd) {
      this.budgets.set(teamId, { count: 1, windowStart: now.getTime() });
    } else {
      existing.count += 1;
    }
  }
}

/**
 * Test whether `now` is inside the configured working window for the
 * owner timezone (§FP-2). Conservative on parsing — invalid inputs
 * default to "always working hours".
 */
export function isWithinWorkingHours(now: Date, config: OffHoursConfig): boolean {
  const window = parseWorkingWindow(config.workingHours);
  if (!window) return true;
  const local = renderLocalHourMinute(now, config.ownerTimezone);
  if (!local) return true;
  const cur = local.hour * 60 + local.minute;
  return cur >= window.startMin && cur < window.endMin;
}

function parseWorkingWindow(str: string): { startMin: number; endMin: number } | null {
  const m = str.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const endMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  if (Number.isNaN(startMin) || Number.isNaN(endMin) || startMin >= endMin) return null;
  return { startMin, endMin };
}

function renderLocalHourMinute(d: Date, tz: string): { hour: number; minute: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? 'NaN', 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? 'NaN', 10);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { hour: hour === 24 ? 0 : hour, minute };
  } catch {
    return null;
  }
}

/**
 * Build the multi-line roll-up Slack message for one detection (§D.5).
 *
 * @param detection - The team's detection
 * @param team - Team summary (for member labels and TL @mention)
 * @param effectiveVerdict - Final verdict after off-hours downgrade
 * @param systemOrphanTotal - System-wide orphan count for context line
 * @returns Slack-ready message text
 */
export function formatRollupMessage(
  detection: TeamHealthDetection,
  team: TeamSummary,
  effectiveVerdict: VerdictCode,
  systemOrphanTotal: number,
): string {
  const display = VERDICT_DISPLAY[effectiveVerdict];
  const teamLabel = team.name ?? team.id;
  const lines: string[] = [];

  if (effectiveVerdict === 'cascade') {
    const others = (detection.cascadeWith ?? []).join(', ');
    lines.push(`${display} Team cascade — ${teamLabel} (also affecting ${others})`);
  } else if (effectiveVerdict === 'stale') {
    lines.push(`${display} Possibly-stale work in ${teamLabel}`);
  } else {
    const tag = effectiveVerdict === 'stuck' ? 'stuck' : 'stalling';
    lines.push(`${display} Team ${tag} — ${teamLabel}`);
  }

  if (detection.pendingWorkItemIds.length > 0) {
    lines.push(`Pending work:  ${detection.pendingWorkItemIds.length} WorkItem(s) (${preview(detection.pendingWorkItemIds)})`);
  }
  if (detection.idleAgentSessions.length > 0) {
    const tlMark = team.tlSession && detection.idleAgentSessions.includes(team.tlSession)
      ? ` (TL ${team.tlSession} idle)`
      : '';
    lines.push(`Idle members:  ${detection.idleAgentSessions.length} session(s)${tlMark}`);
  }
  if (detection.staleWorkItemIds && detection.staleWorkItemIds.length > 0) {
    lines.push(`Stale-fire suspects: ${preview(detection.staleWorkItemIds)}`);
  }
  if (detection.lostDispatchWorkItemIds && detection.lostDispatchWorkItemIds.length > 0) {
    lines.push(`Lost-dispatch suspects: ${preview(detection.lostDispatchWorkItemIds)}`);
  }
  if (detection.orphanRequestIds && detection.orphanRequestIds.length > 0) {
    lines.push(
      `Orphan Requests: ${detection.orphanRequestIds.length} (system-wide: ${systemOrphanTotal})`,
    );
  }

  lines.push('');
  lines.push(detection.rationale);
  lines.push('');
  lines.push('Suggested next step:');
  if (effectiveVerdict === 'stuck' && team.tlSession) {
    lines.push(`  • Restart TL: \`start-agent --member ${team.tlSession}\``);
  }
  if (effectiveVerdict === 'stuck' || effectiveVerdict === 'cascade') {
    lines.push('  • Or reassign top-of-queue WorkItem to a sibling team');
  }
  if (effectiveVerdict === 'stale') {
    lines.push('  • Confirm cancel with the assignee or push back via TL');
  }
  if (
    effectiveVerdict === 'stalling' &&
    ((detection.orphanRequestIds?.length ?? 0) > 0 ||
      (detection.lostDispatchWorkItemIds?.length ?? 0) > 0)
  ) {
    lines.push('  • Investigate — orphan Request or lost-dispatch suspected');
  }

  lines.push('');
  lines.push('Suppress this alert: react with 🔇 (silences for 2h)');

  return lines.join('\n');
}

/**
 * Build the recovery message — short factual line, cooldown=0 (§6.3).
 */
export function formatRecoveryMessage(
  team: TeamSummary,
  detection: TeamHealthDetection,
  now: Date,
): string {
  void detection;
  const teamLabel = team.name ?? team.id;
  return `${VERDICT_DISPLAY.healthy} ${teamLabel} recovered at ${now.toISOString()}.`;
}

function formatHealthyNoOp(team: TeamSummary, detection: TeamHealthDetection): string {
  void detection;
  return `${VERDICT_DISPLAY.healthy} ${team.id} healthy.`;
}

function preview(ids: string[], max: number = 3): string {
  if (ids.length <= max) return ids.join(', ');
  return `${ids.slice(0, max).join(', ')}, +${ids.length - max} more`;
}
