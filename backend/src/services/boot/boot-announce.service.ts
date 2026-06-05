/**
 * Boot Announce Service
 *
 * Posts a one-time "back online" message to the owner's channel after the
 * backend restarts and the orchestrator is ready, so a restart is visible
 * instead of silent. The message is deterministic (composed here, not by the
 * orchestrator) and reports startup success + the running version, optionally
 * enriched with how long the system was offline and how many queued messages
 * were replayed.
 *
 * Design: the composer is PURE (unit-testable); sending takes injected
 * dependencies (Slack connectivity + sender + logger) so the I/O is testable
 * and the caller in index.ts stays thin. Sending is best-effort — any failure
 * is swallowed and logged, never blocking boot.
 *
 * v1 targets Slack (the owner's primary channel). Posting to the web chat
 * (chat-v2) can be layered on later via the same composer.
 *
 * @module services/boot/boot-announce.service
 */

import { existsSync, writeFileSync } from 'fs';

/** Inputs describing the just-completed boot. */
export interface BootAnnounceInfo {
  /** The running Crewly version, e.g. "1.11.3". */
  version: string;
  /** True on the first-ever boot (welcome) vs a restart (back-online). */
  firstBoot?: boolean;
  /** How long the system was offline before this boot, in ms (optional). */
  offlineDurationMs?: number;
  /** How many queued offline messages were replayed on boot (optional). */
  replayedCount?: number;
}

/** A composed announcement ready to send. */
export interface BootAnnounceMessage {
  /** Short title / headline. */
  title: string;
  /** Body text (one fact per line). */
  message: string;
}

/**
 * Formats a millisecond duration as a short human-readable Chinese string.
 *
 * @param ms - Duration in milliseconds.
 * @returns e.g. "<1 分钟", "12 分钟", "2 小时 5 分钟".
 */
function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1 分钟';
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/**
 * Composes the boot announcement text. Pure — no I/O.
 *
 * Always includes startup success + version. Adds an offline-duration line and
 * a replayed-messages line only when those values are present and meaningful.
 *
 * @param info - The boot info (version required; offline/replayed optional).
 * @returns The title + message to send.
 *
 * @example
 * composeBootAnnouncement({ version: '1.11.3', offlineDurationMs: 720000, replayedCount: 3 })
 * // → { title: '✅ Crewly 已重启上线', message: '• 版本: 1.11.3\n• 离线: 12 分钟\n• 已补处理: 3 条离线消息' }
 */
export function composeBootAnnouncement(info: BootAnnounceInfo): BootAnnounceMessage {
  // First-ever boot: a welcome, not a "restarted" message — and offline /
  // replayed lines are meaningless (there was no prior run).
  if (info.firstBoot) {
    return {
      title: '🎉 欢迎使用 Crewly！',
      message: `Crewly 已启动并就绪。\n• 版本: ${info.version}`,
    };
  }

  const lines: string[] = [`• 版本: ${info.version}`];
  if (typeof info.offlineDurationMs === 'number' && info.offlineDurationMs > 0) {
    lines.push(`• 离线: ${formatDuration(info.offlineDurationMs)}`);
  }
  if (typeof info.replayedCount === 'number' && info.replayedCount > 0) {
    lines.push(`• 已补处理: ${info.replayedCount} 条离线消息`);
  }
  return {
    title: '✅ Crewly 已重启上线',
    message: lines.join('\n'),
  };
}

/** Injected dependencies for sending the announcement (keeps I/O testable). */
export interface BootAnnounceDeps {
  /** Whether the Slack channel is currently connected. */
  isSlackConnected: () => boolean;
  /** Sends the composed announcement to Slack (e.g. via sendNotification). */
  sendSlack: (msg: BootAnnounceMessage) => Promise<void>;
  /** Minimal logger. */
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Sends the boot announcement. Best-effort: skips silently when Slack is not
 * connected, and swallows any send error (logged as a warning) so a failed
 * announcement never affects startup.
 *
 * @param info - The boot info to announce.
 * @param deps - Injected Slack connectivity + sender + logger.
 */
export async function sendBootAnnouncement(
  info: BootAnnounceInfo,
  deps: BootAnnounceDeps,
): Promise<void> {
  const composed = composeBootAnnouncement(info);
  try {
    if (!deps.isSlackConnected()) {
      deps.logger.info('Boot announce: Slack not connected — skipping', { version: info.version });
      return;
    }
    await deps.sendSlack(composed);
    deps.logger.info('Boot announce sent', { version: info.version });
  } catch (err) {
    deps.logger.warn('Boot announce failed (non-critical)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns true if no boot marker exists yet — i.e. this is the first-ever boot.
 *
 * @param markerPath - Absolute path to the boot marker file.
 * @returns True when the marker is absent.
 */
export function isFirstBoot(markerPath: string): boolean {
  return !existsSync(markerPath);
}

/**
 * Persists the boot marker so subsequent boots are recognized as restarts.
 * Best-effort: if the write fails, a future boot may re-show the welcome — harmless.
 *
 * @param markerPath - Absolute path to the boot marker file.
 */
export function markBooted(markerPath: string): void {
  try {
    writeFileSync(markerPath, new Date().toISOString());
  } catch {
    // Ignore — persistence is best-effort.
  }
}
