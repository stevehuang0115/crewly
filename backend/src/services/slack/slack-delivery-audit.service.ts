/**
 * Slack delivery audit — owner messages Slack has that never reached a machine.
 *
 * Earlier audits read only the local chat.db, so a message that never
 * reached this machine could not show up in them. The 2026-10-03 #content-team
 * message was one: Cloud pushed it to the Air only, and the Mac, where the
 * room's agents run, never recorded it. This audit starts from Slack instead:
 *
 *   1. every channel this machine maps, read with a bot that is a member
 *      (`conversations.history`, plus `conversations.replies` for threads
 *      active in the window);
 *   2. the owner's messages in it;
 *   3. each one checked against this machine's chat.db and against Cloud's
 *      routing log (which machine it was pushed to, and why).
 *
 * See specs/2026-10-04-room-delivery-audit.md.
 *
 * @module services/slack/slack-delivery-audit.service
 */

import type { CloudRoutingDecision } from '../../types/slack.types.js';

/** A mapped channel and the local agents in it. */
export interface AuditRoom {
  slackChannelId: string;
  slackChannelName: string;
  members: string[];
}

/** Collaborators, injectable for tests. */
export interface SlackDeliveryAuditDeps {
  /** Every Slack channel this machine maps, with its local members. */
  listRooms: () => Promise<AuditRoom[]>;
  /** A bot token that can read a channel: one of its members' own bots. */
  tokenFor: (members: string[]) => string | null;
  /** The owner's Slack user id; when unknown every human message is audited. */
  ownerUserId: () => string | null | undefined;
  /** Whether this machine recorded the Slack message. */
  hasLocal: (slackChannelId: string, slackTs: string) => boolean;
  /** Cloud's routing log for one channel since a time; null when Cloud cannot be asked. */
  cloudDecisions?: (channel: string, since: Date) => Promise<CloudRoutingDecision[] | null>;
  /** This machine's instance id (to tell "pushed here" from "pushed elsewhere"). */
  instanceId?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** What happened to one owner message. */
export type AuditVerdict =
  | 'reached-here'
  | 'reached-other-instance'
  | 'pushed-here-not-recorded'
  | 'never-reached'
  | 'no-cloud-record';

/** One owner message and where it went. */
export interface AuditedMessage {
  channel: string;
  channelName: string;
  ts: string;
  threadTs: string | null;
  at: string;
  text: string;
  reachedHere: boolean;
  cloud: {
    rule: string;
    owner: string | null;
    targets: string[];
    pushedTo: string[];
    queued: Array<{ instanceId: string; error?: string }>;
    reason: string;
  } | null;
  verdict: AuditVerdict;
}

/** The audit's result. */
export interface DeliveryAuditReport {
  since: string;
  instanceId: string | null;
  cloudLog: 'available' | 'unavailable';
  channels: Array<{ channel: string; name: string; readable: boolean; error?: string; ownerMessages: number }>;
  messages: AuditedMessage[];
  summary: {
    total: number;
    reachedHere: number;
    reachedElsewhere: number;
    /** pushed-here-not-recorded + never-reached + no-cloud-record */
    missing: number;
  };
}

/** Raw Slack message fields the audit reads. */
interface RawMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** Limits. */
export const SLACK_DELIVERY_AUDIT_CONSTANTS = {
  DEFAULT_HOURS: 24,
  MAX_HOURS: 168,
  /** Threads read per channel (each is one `conversations.replies` call). */
  MAX_THREADS_PER_CHANNEL: 20,
  /** `conversations.history` pages per channel. */
  MAX_HISTORY_PAGES: 5,
  PAGE_SIZE: 200,
  API_BASE_URL: 'https://slack.com/api',
  FETCH_TIMEOUT_MS: 10_000,
  TEXT_PREVIEW_CHARS: 80,
} as const;

/** Subtypes that are still a person speaking. */
const HUMAN_SUBTYPES = new Set(['', 'thread_broadcast', 'file_share']);

/**
 * Service — see module docs.
 */
export class SlackDeliveryAuditService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: SlackDeliveryAuditDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Audit the owner's messages of the last `hours` hours. Never throws for
   * one channel's failure — that channel is listed with its error.
   *
   * @param options - `hours` (default 24, max 168)
   * @returns The report
   */
  async audit(options: { hours?: number } = {}): Promise<DeliveryAuditReport> {
    const C = SLACK_DELIVERY_AUDIT_CONSTANTS;
    const hours = Math.max(1, Math.min(Math.floor(options.hours ?? C.DEFAULT_HOURS), C.MAX_HOURS));
    const sinceMs = this.now() - hours * 3600 * 1000;
    const since = new Date(sinceMs);
    const oldest = (sinceMs / 1000).toFixed(6);
    const me = this.deps.instanceId ? await this.deps.instanceId().catch(() => null) : null;
    const owner = this.deps.ownerUserId() ?? null;
    const rooms = await this.deps.listRooms();
    const report: DeliveryAuditReport = {
      since: since.toISOString(),
      instanceId: me,
      cloudLog: this.deps.cloudDecisions ? 'available' : 'unavailable',
      channels: [],
      messages: [],
      summary: { total: 0, reachedHere: 0, reachedElsewhere: 0, missing: 0 },
    };

    const seen = new Set<string>();
    for (const room of rooms) {
      if (seen.has(room.slackChannelId)) continue;
      seen.add(room.slackChannelId);
      const token = this.deps.tokenFor(room.members);
      if (!token) {
        report.channels.push({ channel: room.slackChannelId, name: room.slackChannelName, readable: false, error: 'no_member_bot_token', ownerMessages: 0 });
        continue;
      }
      const read = await this.readChannel(token, room.slackChannelId, oldest);
      if (!read.ok) {
        report.channels.push({ channel: room.slackChannelId, name: room.slackChannelName, readable: false, error: read.error, ownerMessages: 0 });
        continue;
      }
      const ownerMessages = read.messages.filter((m) => isPersonMessage(m) && (!owner || m.user === owner) && Number(m.ts) >= sinceMs / 1000);
      report.channels.push({ channel: room.slackChannelId, name: room.slackChannelName, readable: true, ownerMessages: ownerMessages.length });
      if (ownerMessages.length === 0) continue;

      let decisions: CloudRoutingDecision[] | null = null;
      if (this.deps.cloudDecisions) {
        decisions = await this.deps.cloudDecisions(room.slackChannelId, since).catch(() => null);
        if (decisions === null) report.cloudLog = 'unavailable';
      }
      const byTs = new Map((decisions ?? []).map((d) => [d.ts, d]));
      for (const m of ownerMessages) {
        const ts = m.ts as string;
        const reachedHere = this.deps.hasLocal(room.slackChannelId, ts);
        const decision = byTs.get(ts) ?? null;
        const cloud = decision ? summarise(decision) : null;
        report.messages.push({
          channel: room.slackChannelId,
          channelName: room.slackChannelName,
          ts,
          threadTs: m.thread_ts && m.thread_ts !== ts ? m.thread_ts : null,
          at: new Date(Number(ts) * 1000).toISOString(),
          text: (m.text ?? '').slice(0, C.TEXT_PREVIEW_CHARS),
          reachedHere,
          cloud,
          verdict: verdictOf(reachedHere, cloud, me),
        });
      }
    }

    report.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of report.messages) {
      report.summary.total++;
      if (m.verdict === 'reached-here') report.summary.reachedHere++;
      else if (m.verdict === 'reached-other-instance') report.summary.reachedElsewhere++;
      else report.summary.missing++;
    }
    return report;
  }

  /**
   * History since `oldest`, plus the replies of threads active in that window.
   *
   * @param token - Bot token of a member
   * @param channel - Slack channel id
   * @param oldest - Slack ts lower bound
   * @returns Messages (top level and thread replies), or the error
   */
  private async readChannel(token: string, channel: string, oldest: string): Promise<{ ok: true; messages: RawMessage[] } | { ok: false; error: string }> {
    const C = SLACK_DELIVERY_AUDIT_CONSTANTS;
    const top: RawMessage[] = [];
    let cursor = '';
    for (let page = 0; page < C.MAX_HISTORY_PAGES; page++) {
      const res = await this.call('conversations.history', token, {
        channel,
        oldest,
        limit: String(C.PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      if (!res.ok) return res;
      top.push(...((res.body['messages'] as RawMessage[] | undefined) ?? []));
      cursor = ((res.body['response_metadata'] as { next_cursor?: string } | undefined)?.next_cursor ?? '').trim();
      if (!cursor) break;
    }
    const out = [...top];
    // `conversations.history` returns only top-level posts: an owner's reply
    // inside a thread is read from the thread itself.
    const threads = top.filter((m) => (m.reply_count ?? 0) > 0 && Number(m.latest_reply ?? m.ts ?? 0) >= Number(oldest)).slice(0, C.MAX_THREADS_PER_CHANNEL);
    for (const parent of threads) {
      const res = await this.call('conversations.replies', token, { channel, ts: parent.ts as string, oldest, limit: String(C.PAGE_SIZE) });
      if (!res.ok) continue;
      for (const r of (res.body['messages'] as RawMessage[] | undefined) ?? []) {
        if (r.ts !== parent.ts) out.push(r);
      }
    }
    return { ok: true, messages: out };
  }

  /**
   * One Slack Web API GET; never throws.
   *
   * @param method - e.g. `conversations.history`
   * @param token - Bot token
   * @param params - Query parameters
   * @returns The body, or the error code
   */
  private async call(method: string, token: string, params: Record<string, string>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
    const C = SLACK_DELIVERY_AUDIT_CONSTANTS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), C.FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${C.API_BASE_URL}/${method}?${new URLSearchParams(params).toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status === 429) return { ok: false, error: 'rate_limited' };
      const body = (await res.json()) as Record<string, unknown>;
      if (!body || body['ok'] !== true) return { ok: false, error: typeof body?.['error'] === 'string' ? (body['error'] as string) : `http_${res.status}` };
      return { ok: true, body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether a Slack message is a person speaking (not a bot, join, edit…).
 *
 * @param m - Raw message
 * @returns True for a person's post
 */
function isPersonMessage(m: RawMessage): boolean {
  return !!m.ts && !!m.user && !m.bot_id && HUMAN_SUBTYPES.has(m.subtype ?? '');
}

/**
 * The parts of a Cloud decision the report shows.
 *
 * @param d - Cloud routing decision
 * @returns Summary
 */
function summarise(d: CloudRoutingDecision): NonNullable<AuditedMessage['cloud']> {
  const deliveries = Object.entries(d.deliveries ?? {});
  return {
    rule: d.rule,
    owner: d.owner,
    targets: d.targets ?? [],
    pushedTo: deliveries.filter(([, o]) => o.status === 'pushed').map(([id]) => id),
    queued: deliveries.filter(([, o]) => o.status === 'queued').map(([id, o]) => ({ instanceId: id, ...(o.error ? { error: o.error } : {}) })),
    reason: d.reason,
  };
}

/**
 * What happened to one owner message.
 *
 * @param reachedHere - This machine recorded it
 * @param cloud - Cloud's routing record, if any
 * @param me - This machine's instance id
 * @returns The verdict
 */
export function verdictOf(reachedHere: boolean, cloud: AuditedMessage['cloud'], me: string | null): AuditVerdict {
  if (reachedHere) return 'reached-here';
  if (!cloud) return 'no-cloud-record';
  if (me && cloud.pushedTo.includes(me)) return 'pushed-here-not-recorded';
  if (cloud.pushedTo.some((id) => id !== me)) return 'reached-other-instance';
  return 'never-reached';
}

let singleton: SlackDeliveryAuditService | null = null;

/** The process-wide audit service, if wired. */
export function getSlackDeliveryAuditService(): SlackDeliveryAuditService | null {
  return singleton;
}

/**
 * Set (or clear) the process-wide audit service.
 *
 * @param service - The service, or null
 */
export function setSlackDeliveryAuditService(service: SlackDeliveryAuditService | null): void {
  singleton = service;
}
