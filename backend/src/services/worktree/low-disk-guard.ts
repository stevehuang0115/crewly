/**
 * Low-disk guard — pure helpers for the disk janitor's free-space check.
 *
 * The janitor checks free space on the volume holding CREWLY_HOME every
 * 10 minutes. Below 15 GB it cleans up at once with shorter idle thresholds;
 * if space is still short it tells the owner (at most once per 24 h, or once
 * per 6 h and marked urgent below 5 GB) what it could not remove and why.
 * This file holds the decisions and the wording; the service does the I/O.
 *
 * @module services/worktree/low-disk-guard
 */

import * as fs from 'fs';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { formatBytes } from './worktree-janitor.git.js';

/** Subset of `fs.StatFs` the guard needs (numbers or bigints). */
export interface StatFsLike {
	/** Free blocks available to unprivileged users */
	bavail: number | bigint;
	/** Block size in bytes */
	bsize: number | bigint;
}

/** `fs.promises.statfs`-compatible probe. */
export type StatFsFn = (p: string) => Promise<StatFsLike>;

/** Disk level relative to the thresholds. */
export type DiskLevel = 'ok' | 'low' | 'critical';

/** When the owner was last told about low disk (persisted). */
export interface LowDiskNoticeState {
	/** Last notice of any kind (ms epoch) */
	lastNoticeAt?: number;
	/** Last urgent notice (ms epoch) */
	lastUrgentAt?: number;
}

/** Something the janitor looked at and left on disk. */
export interface KeptItem {
	/** Absolute path */
	path: string;
	/** Size in bytes */
	bytes: number;
	/** Janitor reason code (`dirty`, `not-merged`, `unpushed`, …) */
	reason: string;
}

/**
 * Free bytes on the volume holding `p`.
 *
 * @param p - Any path on the volume
 * @param statfs - Probe (default `fs.promises.statfs`)
 * @returns Free bytes for unprivileged users, or null when the probe failed
 */
export async function readFreeBytes(p: string, statfs: StatFsFn = defaultStatFs): Promise<number | null> {
	try {
		const s = await statfs(p);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

async function defaultStatFs(p: string): Promise<StatFsLike> {
	return fs.promises.statfs(p);
}

/**
 * Classify free space.
 *
 * @param freeBytes - Free bytes
 * @returns `critical` below CRITICAL_DISK_BYTES, `low` below LOW_DISK_BYTES, else `ok`
 */
export function diskLevel(freeBytes: number): DiskLevel {
	if (freeBytes < WORKTREE_JANITOR_CONSTANTS.CRITICAL_DISK_BYTES) return 'critical';
	if (freeBytes < WORKTREE_JANITOR_CONSTANTS.LOW_DISK_BYTES) return 'low';
	return 'ok';
}

/**
 * Idle threshold to use, shortened in low-disk mode.
 *
 * @param normalMs - Threshold in normal mode
 * @param lowDisk - Whether free space is below LOW_DISK_BYTES
 * @returns `normalMs`, or `normalMs / LOW_DISK_IDLE_DIVISOR` floored at LOW_DISK_MIN_IDLE_FLOOR_MS
 *
 * @example
 * ```typescript
 * idleThreshold(24 * HOUR, true); // 12 h
 * idleThreshold(2 * HOUR, true);  // 2 h (floor)
 * ```
 */
export function idleThreshold(normalMs: number, lowDisk: boolean): number {
	if (!lowDisk) return normalMs;
	const halved = normalMs / WORKTREE_JANITOR_CONSTANTS.LOW_DISK_IDLE_DIVISOR;
	return Math.max(Math.min(normalMs, WORKTREE_JANITOR_CONSTANTS.LOW_DISK_MIN_IDLE_FLOOR_MS), halved);
}

/**
 * Whether to tell the owner now, and how.
 *
 * @param level - Current disk level (after cleanup)
 * @param state - When the owner was last told
 * @param now - Current time (ms)
 * @returns `urgent`, `normal`, or null (nothing to send)
 */
export function noticeToSend(level: DiskLevel, state: LowDiskNoticeState, now: number): 'urgent' | 'normal' | null {
	if (level === 'ok') return null;
	if (level === 'critical') {
		const last = state.lastUrgentAt;
		return last === undefined || now - last >= WORKTREE_JANITOR_CONSTANTS.CRITICAL_DISK_NOTIFY_INTERVAL_MS ? 'urgent' : null;
	}
	const last = state.lastNoticeAt;
	return last === undefined || now - last >= WORKTREE_JANITOR_CONSTANTS.LOW_DISK_NOTIFY_INTERVAL_MS ? 'normal' : null;
}

/**
 * The state after a notice went out.
 *
 * @param state - Previous state
 * @param kind - What was sent
 * @param now - Send time (ms)
 * @returns New state
 */
export function recordNotice(state: LowDiskNoticeState, kind: 'urgent' | 'normal', now: number): LowDiskNoticeState {
	return { ...state, lastNoticeAt: now, ...(kind === 'urgent' ? { lastUrgentAt: now } : {}) };
}

const REASON_TEXT: Record<string, string> = {
	dirty: 'has changes that were never committed',
	'not-merged': 'has work that is not merged yet',
	unpushed: 'has commits that were never pushed',
	stash: 'has stashed changes',
	'no-remote': 'is a git repo with no remote, so its history may exist nowhere else',
	'has-external-worktrees': 'has a worktree somewhere else that depends on it',
	'contains-worktree': 'holds a worktree that is still in use or not finished',
	recent: 'was used recently',
	locked: 'is locked by a running tool',
	'process-inside': 'a program is still open in it',
	'agent-session-inside': 'an agent is working in it',
	'cwd-probe-failed': 'could not check whether a program is using it',
	'managed-by-workitem-worktrees': 'belongs to an open task',
	'status-failed': 'git could not read it',
	'git-failed': 'git could not read it',
	'remove-failed': 'deleting it failed',
};

/**
 * Plain-English reason for a kept item.
 *
 * @param reason - Janitor reason code
 * @returns Short phrase ("has changes that were never committed")
 */
export function describeReason(reason: string): string {
	return REASON_TEXT[reason] ?? `kept (${reason})`;
}

/**
 * Owner notice for low disk: free space, what was freed, and the biggest
 * items left with the reason, short enough for a phone.
 *
 * @param input - Free bytes, urgency, bytes freed this pass, kept items
 * @returns Title and message
 */
export function buildLowDiskNotice(input: {
	freeBytes: number;
	urgent: boolean;
	freedBytes: number;
	items: KeptItem[];
}): { title: string; message: string } {
	const title = input.urgent ? 'URGENT: disk almost full' : 'Disk space is running low';
	const lines: string[] = [];
	lines.push(`Only ${formatBytes(input.freeBytes)} free on this machine.${input.urgent ? ' Crewly and the agents may stop working soon.' : ''}`);
	lines.push(
		input.freedBytes > 0
			? `I cleaned up ${formatBytes(input.freedBytes)} of finished work, but it is not enough.`
			: 'I found nothing more that is safe to delete on my own.',
	);
	const top = [...input.items].sort((a, b) => b.bytes - a.bytes).slice(0, WORKTREE_JANITOR_CONSTANTS.LOW_DISK_REPORT_ITEMS);
	if (top.length > 0) {
		lines.push('', 'Biggest things I left alone:');
		for (const it of top) lines.push(`• ${it.path} (${formatBytes(it.bytes)}) — ${describeReason(it.reason)}`);
		lines.push('', 'Tell me which ones can go, or free up space another way.');
	} else {
		lines.push('Please free up some space.');
	}
	return { title, message: lines.join('\n') };
}
