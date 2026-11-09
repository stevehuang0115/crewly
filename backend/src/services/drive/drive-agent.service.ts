/**
 * DriveAgentService — the machine side of Drive mode
 * (specs/2026-10-08-drive-mode.md §7). Crewly Cloud hosts the session (the
 * voice, the targets, the inbox); this machine does what only it can:
 *
 *  - `deliver` (push `op:'deliver'`): fetch the owner's words from Cloud with
 *    this machine's token, record them as the owner's voice turn in the
 *    agent's DM (a team → its lead's DM; a channel → a thread in its room)
 *    and deliver them, with a note: the owner is listening, answer with
 *    `reply --drive <session>`, not in Slack;
 *  - `agentReply` (`reply --drive`): record the answer in that conversation
 *    (kept off Slack) and send it to Cloud for the phone;
 *  - `noteChatTurn`: a plain `reply` in a Drive conversation still reaches
 *    the phone;
 *  - `recall` (push `op:'recall'`): read back an agent's recent messages to
 *    the owner;
 *  - `end` (push `op:'end'`): ask each agent with an open conversation for
 *    ONE recap; the recap (`reply --drive … --recap`) is posted in the
 *    owner's DM with the agent, or in the channel, and closes the
 *    conversation: owner-message tracking stops, and the open-items tracker
 *    takes it as delivered unless it names a next step.
 *  - `warm` (push `op:'warm'`, v3): read which agents to keep warm from
 *    Cloud, record them in the keep-warm registry (idle stop and slot freeing
 *    leave them alone) and pre-start the ones that are stopped;
 *  - `refresh` (push `op:'refresh'`): the session just opened and the voice
 *    is about to check with the teams: ask the agents that hold the owner's
 *    open items to bring them up to date, then rebuild and upload the
 *    status snapshot so the voice reads fresh state (`deps.refreshStatus`);
 *  - `log` (push `op:'log'`, v4): Cloud keeps every session's log; this
 *    machine stores a copy as `~/.crewly/drive-logs/<date>-<sessionId>.md` +
 *    `.jsonl` (see drive-log.store.ts), readable by a local Claude Code;
 *  - two-phase answers (v3): the delivered words ask for `reply --drive
 *    --ack` within seconds, then the full result;
 *  - meetings (P2b, crewly#1415, `deps.meeting`): `meeting_pack` builds the
 *    pack for a 1:1 meeting with one agent, `wiki_search` searches its wiki
 *    live, and a delivery carrying `writeBack` is written into the thread it
 *    belongs to (drive-meeting.service.ts) and reported back as written.
 *
 * Nothing the owner or the agents say is written to this machine's server
 * logs; the session log above is a separate file, kept 30 days.
 *
 * @module services/drive/drive-agent.service
 */

import { DRIVE_CONSTANTS, MEETING_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { clip, speakable } from '../briefing/briefing.utils.js';
import { getDriveLogStore, type DriveLogStore } from './drive-log.store.js';
import type { OwnerTurnMark } from '../briefing/briefing-cards.js';
import type { IncomingMessage } from '../cloud/cloud-sync.types.js';
import { isDriveModeRow } from './drive-row.utils.js';
import { messagesToOwner, pickRecall, type RecallFeedMessage } from './drive-recall.js';
import type { DriveMeetingService } from './drive-meeting.service.js';
import {
  parseDeliveryFetch,
  parseDriveRelayData,
  parseMeetingPackFetch,
  parseRecallFetch,
  parseStateFetch,
  parseWikiFetch,
  type DriveDeliveryFetch,
  type DriveRelayData,
  type DriveTargetKind,
} from './drive-cloud.contract.js';
import type { DriveConversationStore, DriveLocalConversation } from './drive-conversation.store.js';
import { getDriveKeepWarm, type DriveKeepWarm } from './drive-keep-warm.js';

const C = DRIVE_CONSTANTS;

/** A recap that says nothing is left to do (the conversation is fully closed). */
const NOTHING_PENDING = /nothing (is )?(pending|left|open)|no next step|next:\s*(none|nothing)\b|没有待办|无待办|没有后续|无后续|不需要后续|没有了/i;

/** A Drive mode failure with an HTTP status (for the agent's `reply`). */
export class DriveAgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DriveAgentError';
  }
}

/** Emitter of relay messages (CloudSyncService). */
export interface DriveRelaySource {
  on(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
  off(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
}

/** The Cloud session (CloudClientService). */
export interface DriveCloud {
  getToken(): string | null;
  getCloudUrl(): string | null;
  tryRefreshToken?(): Promise<boolean>;
}

/** A chat-v2 message the fallback pickup looks at. */
export interface DriveChatTurn {
  id: string;
  channelId: string;
  threadId?: string;
  senderType: string;
  senderId: string;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/** Collaborators. */
export interface DriveAgentDeps {
  source?: DriveRelaySource;
  cloud: DriveCloud;
  /** This machine's Cloud instance id */
  identity: () => Promise<{ instanceId: string }>;
  /**
   * Record the owner's words as an owner turn and deliver them: the agent's
   * DM (agent / team lead), or the room of a team channel (a new thread on
   * the first turn, then that thread). `text` (with the Drive mode note) goes
   * to the agent; `ownerText` (the owner's words alone) is what the chat shows.
   */
  deliverOwnerTurn: (input: {
    kind: DriveTargetKind;
    agentSession: string;
    slackChannelId?: string;
    channelId?: string;
    threadId?: string;
    text: string;
    ownerText: string;
  }) => Promise<{ channelId: string; threadId?: string }>;
  /** Record an agent's spoken answer in its conversation (chat-v2, kept off Slack) */
  recordAgentTurn: (input: { agentSession: string; channelId: string; threadId?: string; text: string; interim: boolean; sessionId: string }) => Promise<void>;
  /** A harness note to an agent (the recap request) */
  notifyAgent: (agentSession: string, text: string) => Promise<boolean>;
  /** Post the recap where the conversation belongs (the DM with the owner / the channel), to Slack too */
  postRecap: (input: { conversation: DriveLocalConversation; agentSession: string; text: string; nextStep: boolean }) => Promise<{ where: string }>;
  /** chat-v2 rows since a time and the owner's last turn per conversation (recall) */
  ownerFeed: (sinceMs: number) => Promise<{ messages: RecallFeedMessage[]; ownerTurns: OwnerTurnMark[] }>;
  /** Stop owner-message tracking for a closed conversation (no more nudges) */
  closeTracking?: (agentSession: string, channelId: string) => void;
  /** Whether an agent exists here */
  agentExists?: (agentSession: string) => Promise<boolean>;
  store: DriveConversationStore;
  /** Keep-warm registry (default: the process-wide one) */
  keepWarm?: DriveKeepWarm;
  /** Start a stopped agent now (it goes ahead of ordinary starts while warm); never throws */
  prestart?: (agentSession: string) => Promise<void>;
  /**
   * Check with the teams (`op:'refresh'`): ask the agents holding the owner's
   * open items for a current status, wait briefly, then rebuild and upload
   * the status snapshot. Resolves when the fresh snapshot is uploaded.
   */
  refreshStatus?: () => Promise<void>;
  /** Where session logs are kept (default: `~/.crewly/drive-logs`) */
  logStore?: DriveLogStore;
  /** 1:1 meetings (P2b): pack, live wiki search and write-backs; absent = not offered */
  meeting?: Pick<DriveMeetingService, 'buildPack' | 'searchWiki' | 'writeBack'>;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  logger?: ComponentLogger;
}

let active = false;
let meetingActive = false;

/**
 * Capabilities to advertise to Cloud (heartbeat and uploads).
 *
 * @returns `['drive_message']` while the handler runs (plus `meeting_pack`
 *   when it builds meeting packs), else `[]`
 */
export function driveCapabilities(): string[] {
  if (!active) return [];
  return meetingActive ? [C.CAPABILITY, MEETING_CONSTANTS.CAPABILITY] : [C.CAPABILITY];
}

/** The machine side of Drive mode — see module docs. */
export class DriveAgentService {
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly inFlight = new Set<string>();
  /** Conversations whose recap is being posted now (`sessionId/conversationId`) */
  private readonly recapping = new Set<string>();
  private readonly listener = (msg: IncomingMessage): void => {
    void this.handle(msg);
  };
  private started = false;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: DriveAgentDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('DriveAgent');
    this.now = deps.now ?? (() => new Date());
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Subscribe to relay messages and advertise the capability. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.source?.on('message', this.listener);
    active = true;
    meetingActive = !!this.deps.meeting;
  }

  /** Unsubscribe. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.source?.off('message', this.listener);
    active = false;
    meetingActive = false;
  }

  /**
   * One relay message; anything but a Drive mode push is ignored. Never throws.
   *
   * @param msg - Relay message
   * @returns What was done
   */
  async handle(msg: IncomingMessage): Promise<'ignored' | 'duplicate' | 'done' | 'failed'> {
    if (msg?.type !== C.RELAY_MESSAGE_TYPE) return 'ignored';
    const data = parseDriveRelayData(msg.payload);
    if (!data) return 'ignored';
    const key = `${data.op}:${data.sessionId}:${data.id ?? ''}`;
    if (this.inFlight.has(key)) return 'duplicate';
    this.inFlight.add(key);
    try {
      const { instanceId } = await this.deps.identity();
      if (data.instanceId !== instanceId) return 'ignored';
      if (data.op === 'deliver') await this.deliver(data, instanceId);
      else if (data.op === 'recall') await this.recall(data, instanceId);
      else if (data.op === 'warm') await this.warm(data, instanceId);
      else if (data.op === 'refresh') await this.deps.refreshStatus?.();
      else if (data.op === 'log') await this.saveLog(data, instanceId);
      else if (data.op === 'meeting_pack') await this.meetingPack(data, instanceId);
      else if (data.op === 'wiki_search') await this.wikiSearch(data, instanceId);
      else await this.end(data, instanceId);
      return 'done';
    } catch (error) {
      this.logger.warn('Drive mode push failed', { op: data.op, sessionId: data.sessionId, error: error instanceof Error ? error.message : String(error) });
      return 'failed';
    } finally {
      this.inFlight.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Owner → agent
  // ---------------------------------------------------------------------------

  private async deliver(data: DriveRelayData, instanceId: string): Promise<void> {
    const raw = await this.cloudGet(`/${data.sessionId}/machine/deliveries/${encodeURIComponent(data.id as string)}?instanceId=${encodeURIComponent(instanceId)}`);
    const d = parseDeliveryFetch(raw);
    if (!d) throw new Error('Cloud sent a malformed delivery');
    if (d.writeBack && this.deps.meeting) {
      await this.writeBack(d, instanceId);
      return;
    }
    await this.deliverFetched(d);
  }

  // ---------------------------------------------------------------------------
  // Meetings (P2b)
  // ---------------------------------------------------------------------------

  /** A meeting outcome: written into its thread (no Drive conversation), then reported to Cloud. */
  private async writeBack(d: DriveDeliveryFetch, instanceId: string): Promise<void> {
    if (this.deps.agentExists && !(await this.deps.agentExists(d.target.agentSession))) {
      throw new Error(`No agent ${d.target.agentSession} on this machine`);
    }
    const meeting = this.deps.meeting as NonNullable<DriveAgentDeps['meeting']>;
    const out = await meeting.writeBack({ sessionId: d.sessionId, agentSession: d.target.agentSession, text: d.text, writeBack: d.writeBack as NonNullable<DriveDeliveryFetch['writeBack']> });
    await this.cloudPost(`/${d.sessionId}/machine/deliveries/${encodeURIComponent(d.id)}/written`, { instanceId, ...(out.threadRef ? { threadRef: out.threadRef } : {}) });
    this.logger.info('Meeting write-back written', { sessionId: d.sessionId, kind: d.writeBack?.kind, via: out.via, newThread: !d.writeBack?.threadRef });
  }

  /** `op:'meeting_pack'`: build the agent's pack and post it. */
  private async meetingPack(data: DriveRelayData, instanceId: string): Promise<void> {
    if (!this.deps.meeting) return;
    const path = `/${data.sessionId}/machine/packs/${encodeURIComponent(data.id as string)}`;
    const req = parseMeetingPackFetch(await this.cloudGet(`${path}?instanceId=${encodeURIComponent(instanceId)}`));
    if (!req) throw new Error('Cloud sent a malformed pack request');
    if (this.deps.agentExists && !(await this.deps.agentExists(req.agentSession))) throw new Error(`No agent ${req.agentSession} on this machine`);
    const pack = await this.deps.meeting.buildPack(req);
    await this.cloudPost(path, { instanceId, pack });
  }

  /** `op:'wiki_search'`: search the agent's wiki and post the hits. */
  private async wikiSearch(data: DriveRelayData, instanceId: string): Promise<void> {
    if (!this.deps.meeting) return;
    const path = `/${data.sessionId}/machine/wiki/${encodeURIComponent(data.id as string)}`;
    const req = parseWikiFetch(await this.cloudGet(`${path}?instanceId=${encodeURIComponent(instanceId)}`));
    if (!req) throw new Error('Cloud sent a malformed wiki search');
    const { hits, ms } = await this.deps.meeting.searchWiki(req);
    await this.cloudPost(path, { instanceId, hits, ms });
  }

  /**
   * Deliver the owner's words (already fetched from Cloud).
   *
   * @param d - Delivery
   * @returns The local conversation
   */
  async deliverFetched(d: DriveDeliveryFetch): Promise<DriveLocalConversation> {
    if (this.deps.agentExists && !(await this.deps.agentExists(d.target.agentSession))) {
      throw new Error(`No agent ${d.target.agentSession} on this machine`);
    }
    const existing = await this.deps.store.get(d.sessionId, d.conversationId);
    const where = await this.deps.deliverOwnerTurn({
      kind: d.target.kind,
      agentSession: d.target.agentSession,
      ...(d.target.slackChannelId ? { slackChannelId: d.target.slackChannelId } : {}),
      ...(existing ? { channelId: existing.channelId, ...(existing.threadId ? { threadId: existing.threadId } : {}) } : {}),
      text: ownerTurnText(d.sessionId, d.target.kind, d.target.name, d.text),
      ownerText: d.text,
    });
    const at = this.now().toISOString();
    const conv = await this.deps.store.update(
      d.sessionId,
      d.conversationId,
      (cur) => {
        const c: DriveLocalConversation = cur ?? {
          sessionId: d.sessionId,
          conversationId: d.conversationId,
          kind: d.target.kind,
          targetName: d.target.name,
          agentSession: d.target.agentSession,
          ...(d.target.members ? { members: d.target.members } : {}),
          channelId: where.channelId,
          ...(where.threadId ? { threadId: where.threadId } : {}),
          startedAt: at,
          turns: [],
        };
        if (!c.threadId && where.threadId) c.threadId = where.threadId;
        c.turns.push({ from: 'owner', name: 'owner', text: d.text, at });
        return c;
      },
      this.now().getTime(),
    );
    this.logger.info('Drive mode: owner words delivered', { sessionId: d.sessionId, conversationId: d.conversationId, kind: d.target.kind, agent: d.target.agentSession });
    return conv as DriveLocalConversation;
  }

  // ---------------------------------------------------------------------------
  // Agent → owner
  // ---------------------------------------------------------------------------

  /**
   * An agent's answer for the owner's phone (`reply --drive <session>`), or
   * its recap (`--recap`).
   *
   * @param agentSession - Who answers
   * @param sessionId - Drive mode session
   * @param input - `{ text, interim, recap }`
   * @returns Which conversation, and whether it closed
   * @throws DriveAgentError 400 / 404 (no such conversation) / 502 (Cloud unreachable)
   */
  async agentReply(agentSession: string, sessionId: string, input: { text: string; interim: boolean; recap: boolean; ack?: boolean }): Promise<{ conversationId: string; closed: boolean }> {
    if (!C.SESSION_ID_PATTERN.test(sessionId)) throw new DriveAgentError(400, 'That is not a Drive mode session id (drv_…).');
    const text = (input.text ?? '').trim();
    if (!text) throw new DriveAgentError(400, 'Reply text is required.');
    if (text.length > C.TEXT_MAX_CHARS) throw new DriveAgentError(400, `Too long for Drive mode (max ${C.TEXT_MAX_CHARS} characters) — say it short; details go in a normal reply.`);
    const conv = pickConversation(await this.deps.store.list(), sessionId, agentSession, input.recap);
    if (!conv) {
      // Say WHY: a conversation that closed reads differently from one that never existed.
      const closed = (await this.deps.store.list())
        .filter((c) => c.sessionId === sessionId && c.closedAt && (c.agentSession === agentSession || (c.members ?? []).includes(agentSession)))
        .sort((a, b) => Date.parse(b.closedAt as string) - Date.parse(a.closedAt as string))[0];
      throw new DriveAgentError(
        404,
        closed
          ? `That Drive mode conversation closed at ${closed.closedAt}, so the owner is no longer listening on the phone. Answer the usual way (reply).`
          : 'You have no open Drive mode conversation in that session. Answer the usual way (reply).',
      );
    }
    if (input.recap) return this.recap(conv, agentSession, text);
    const interim = input.interim || input.ack === true;
    await this.deps.recordAgentTurn({ agentSession, channelId: conv.channelId, ...(conv.threadId ? { threadId: conv.threadId } : {}), text, interim, sessionId });
    await this.forward(conv, agentSession, text, { interim, ...(input.ack ? { ack: true } : {}) });
    return { conversationId: conv.conversationId, closed: false };
  }

  /**
   * Fallback: an agent answered a Drive mode conversation with a plain
   * `reply` instead of `reply --drive`. Its words still reach the phone. Call
   * for every chat-v2 message. Never throws.
   *
   * @param dto - The chat message
   */
  async noteChatTurn(dto: DriveChatTurn): Promise<void> {
    try {
      if (dto.senderType !== 'agent' || isDriveModeRow(dto) || !dto.content.trim()) return;
      const open = (await this.deps.store.list()).filter((c) => !c.closedAt && c.channelId === dto.channelId && (!c.threadId || dto.threadId === c.threadId));
      for (const c of open.reverse()) {
        if (dto.senderId !== c.agentSession && !(c.members ?? []).includes(dto.senderId)) continue;
        const lastOwner = [...c.turns].reverse().find((t) => t.from === 'owner');
        const lastAgent = [...c.turns].reverse().find((t) => t.from === 'agent' && !t.interim);
        if (!lastOwner || (lastAgent && Date.parse(lastAgent.at) >= Date.parse(lastOwner.at))) continue;
        if (dto.createdAt < Date.parse(lastOwner.at)) continue;
        await this.forward(c, dto.senderId, dto.content, { interim: dto.metadata?.interim === true });
        this.logger.info('Drive mode: picked up a plain reply', { sessionId: c.sessionId, conversationId: c.conversationId });
        return;
      }
    } catch (err) {
      this.logger.warn('Drive mode: plain reply not forwarded', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async recap(conv: DriveLocalConversation, agentSession: string, text: string): Promise<{ conversationId: string; closed: boolean }> {
    // A second `--recap` while the first is still posting (a retried call) is the
    // same recap: the owner got the same recap 2–3 times seconds apart (2026-10-22 audit).
    const key = `${conv.sessionId}/${conv.conversationId}`;
    if (this.recapping.has(key)) return { conversationId: conv.conversationId, closed: true };
    this.recapping.add(key);
    try {
      return await this.postRecapOnce(conv, agentSession, text);
    } finally {
      this.recapping.delete(key);
    }
  }

  private async postRecapOnce(conv: DriveLocalConversation, agentSession: string, text: string): Promise<{ conversationId: string; closed: boolean }> {
    const nextStep = !NOTHING_PENDING.test(text);
    const posted = await this.deps.postRecap({ conversation: conv, agentSession, text, nextStep });
    await this.forward(conv, agentSession, text, { recap: true, nextStep }).catch((err) => {
      // The recap is posted where it belongs; Cloud learning of it is best effort.
      this.logger.warn('Drive mode: recap not reported to Cloud', { error: err instanceof Error ? err.message : String(err) });
    });
    await this.deps.store.update(conv.sessionId, conv.conversationId, (cur) => (cur ? { ...cur, closedAt: this.now().toISOString() } : null), this.now().getTime());
    this.deps.closeTracking?.(conv.agentSession, conv.channelId);
    this.logger.info('Drive mode recap posted; conversation closed', { sessionId: conv.sessionId, conversationId: conv.conversationId, where: posted.where, nextStep });
    return { conversationId: conv.conversationId, closed: true };
  }

  /** Send an answer to Cloud and keep the local transcript. */
  private async forward(conv: DriveLocalConversation, agentSession: string, text: string, opts: { interim?: boolean; ack?: boolean; recap?: boolean; nextStep?: boolean }): Promise<void> {
    const { instanceId } = await this.deps.identity();
    await this.cloudPost(`/${conv.sessionId}/replies`, {
      instanceId,
      conversationId: conv.conversationId,
      agentSession,
      text: text.slice(0, C.TEXT_MAX_CHARS),
      ...(opts.interim ? { interim: true } : {}),
      ...(opts.ack ? { ack: true } : {}),
      ...(opts.recap ? { recap: true, nextStep: !!opts.nextStep } : {}),
    });
    if (opts.recap) return;
    const at = this.now().toISOString();
    await this.deps.store.update(
      conv.sessionId,
      conv.conversationId,
      (cur) => (cur ? { ...cur, turns: [...cur.turns, { from: 'agent', name: agentSession, text: clip(speakable(text), 600), at, ...(opts.interim ? { interim: true } : {}) }] } : null),
      this.now().getTime(),
    );
  }

  // ---------------------------------------------------------------------------
  // Recall / end
  // ---------------------------------------------------------------------------

  private async recall(data: DriveRelayData, instanceId: string): Promise<void> {
    const path = `/${data.sessionId}/machine/recalls/${encodeURIComponent(data.id as string)}`;
    const req = parseRecallFetch(await this.cloudGet(`${path}?instanceId=${encodeURIComponent(instanceId)}`));
    if (!req) throw new Error('Cloud sent a malformed recall');
    const feed = await this.deps.ownerFeed(this.now().getTime() - C.RECALL_WINDOW_MS);
    const messages = pickRecall(messagesToOwner(feed.messages, feed.ownerTurns, req.agentSessions), req.hint);
    await this.cloudPost(path, { instanceId, messages });
  }

  /**
   * Keep the agents Cloud names warm while the session runs, and start the
   * ones that are stopped now (warm agents go ahead of ordinary starts).
   */
  private async warm(data: DriveRelayData, instanceId: string): Promise<void> {
    const state = parseStateFetch(await this.cloudGet(`/${data.sessionId}/machine/state?instanceId=${encodeURIComponent(instanceId)}`));
    if (!state) throw new Error('Cloud sent a malformed session state');
    const registry = this.deps.keepWarm ?? getDriveKeepWarm();
    if (state.ended) {
      registry.end(data.sessionId);
      return;
    }
    const fresh = registry.set(data.sessionId, state.warm, state.warmUntil);
    if (fresh.length) this.logger.info('Drive mode: keeping agents warm', { sessionId: data.sessionId, agents: fresh });
    for (const agent of fresh) await this.deps.prestart?.(agent).catch(() => undefined);
  }

  /** Keep the session log (`op:'log'`): fetch it from Cloud and write it under `~/.crewly/drive-logs/`. */
  private async saveLog(data: DriveRelayData, instanceId: string): Promise<void> {
    const raw = (await this.cloudGet(`/${data.sessionId}/machine/log?instanceId=${encodeURIComponent(instanceId)}`)) as { base?: unknown; markdown?: unknown; jsonl?: unknown } | null;
    if (!raw || typeof raw.base !== 'string' || typeof raw.markdown !== 'string' || typeof raw.jsonl !== 'string') throw new Error('Cloud sent a malformed session log');
    const file = await (this.deps.logStore ?? getDriveLogStore()).save(raw.base, raw.markdown, raw.jsonl);
    this.logger.info('Drive mode: session log saved', { sessionId: data.sessionId, file });
  }

  private async end(data: DriveRelayData, instanceId: string): Promise<void> {
    const state = parseStateFetch(await this.cloudGet(`/${data.sessionId}/machine/state?instanceId=${encodeURIComponent(instanceId)}`));
    if (!state || !state.ended) return;
    (this.deps.keepWarm ?? getDriveKeepWarm()).end(data.sessionId);
    const wanted = new Set(state.conversations.map((c) => c.conversationId));
    const local = (await this.deps.store.list()).filter((c) => c.sessionId === data.sessionId && wanted.has(c.conversationId) && !c.closedAt && !c.recapAskedAt);
    // One recap per agent: an agent that answered for itself and for its team posted two recaps to the owner (2026-10-22).
    const byAgent = new Map<string, DriveLocalConversation[]>();
    for (const c of local) byAgent.set(c.agentSession, [...(byAgent.get(c.agentSession) ?? []), c]);
    for (const [agentSession, cs] of byAgent) {
      const ok = await this.deps.notifyAgent(agentSession, recapRequest(cs)).catch(() => false);
      if (!ok) {
        this.logger.warn('Drive mode: could not ask for a recap', { sessionId: data.sessionId, conversationIds: cs.map((c) => c.conversationId), agent: agentSession });
        continue;
      }
      for (const c of cs) await this.deps.store.update(c.sessionId, c.conversationId, (cur) => (cur ? { ...cur, recapAskedAt: this.now().toISOString() } : null), this.now().getTime());
    }
  }

  // ---------------------------------------------------------------------------
  // Cloud
  // ---------------------------------------------------------------------------

  private async cloudGet(path: string): Promise<unknown> {
    return this.cloudCall('GET', path);
  }

  private async cloudPost(path: string, body: unknown): Promise<unknown> {
    return this.cloudCall('POST', path, body);
  }

  private async cloudCall(method: 'GET' | 'POST', path: string, body?: unknown, refreshed = false): Promise<unknown> {
    const base = this.deps.cloud.getCloudUrl();
    const token = this.deps.cloud.getToken();
    if (!base || !token) throw new DriveAgentError(503, 'This machine is not signed in to Crewly Cloud.');
    let res: Response;
    try {
      res = await this.fetchImpl(`${base.replace(/\/+$/, '')}${C.CLOUD_BASE_PATH}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DriveAgentError(502, 'Could not reach Crewly Cloud — try again in a moment.');
    }
    if (res.status === 401 && !refreshed && this.deps.cloud.tryRefreshToken && (await this.deps.cloud.tryRefreshToken())) {
      return this.cloudCall(method, path, body, true);
    }
    let json: { success?: boolean; data?: unknown; error?: unknown } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      json = {};
    }
    if (!res.ok || json.success === false) {
      const why = typeof json.error === 'string' ? json.error : `Crewly Cloud answered ${res.status}`;
      throw new DriveAgentError(res.status >= 500 ? 502 : res.status, why);
    }
    return json.data;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The owner's words as delivered: the Drive mode note, then the words.
 *
 * @param sessionId - Session
 * @param kind - Target kind
 * @param name - Target name
 * @param text - The owner's words
 * @returns Message text
 */
export function ownerTurnText(sessionId: string, kind: DriveTargetKind, name: string, text: string): string {
  const forTeam = kind === 'team' ? ` This is for the ${name} team: answer for the team, or hand it on.` : '';
  return (
    `[Drive mode · session ${sessionId}] The owner is driving and LISTENING on the phone, not reading.${forTeam}\n` +
    `1. Within seconds, before any other work: reply --drive ${sessionId} --ack "<one short sentence: got it and how long, or the direct answer>".\n` +
    `2. If it needs work, do it, then: reply --drive ${sessionId} "<the result>" — conclusion first, at most 3 short spoken sentences; ` +
    'if he must decide, give 2–3 options. No URLs, tables, code or ids; details go in your end-of-session recap. Not in Slack. ' +
    'If the ack already answered it, you are done.\n\n' +
    text
  );
}

/**
 * The harness note asking an agent for its recap: one recap however many
 * of the session's conversations the agent answered (its own, its team's).
 *
 * @param conv - The agent's conversation(s) in the session
 * @returns Note text
 */
export function recapRequest(conv: DriveLocalConversation | readonly DriveLocalConversation[]): string {
  const cs = Array.isArray(conv) ? (conv as readonly DriveLocalConversation[]) : [conv as DriveLocalConversation];
  const c = cs[0];
  const placeOf = (x: DriveLocalConversation): string => (x.kind === 'channel' ? x.targetName : x.kind === 'team' ? `your DM with the owner (for the ${x.targetName} team)` : 'your DM with the owner');
  const where = placeOf(c);
  const transcript = cs
    .flatMap((x) => x.turns.map((t) => ({ ...t, label: cs.length > 1 && x.kind === 'team' ? ` (as the ${x.targetName} team)` : '' })))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-12 * cs.length)
    .map((t) => `${t.from === 'owner' ? 'Owner' : t.name}${t.label}: ${clip(t.text, 400)}`)
    .join('\n');
  const several = cs.length > 1 ? ` You answered in ${cs.length} conversations of it (${cs.map((x) => (x.kind === 'team' ? `for the ${x.targetName} team` : x.kind === 'channel' ? x.targetName : 'as yourself')).join(', ')}): ONE recap covers them all.` : '';
  return [
    `[Drive mode ended · session ${c.sessionId}] The owner ended the Drive mode conversation with you.${several} Post ONE recap now, for reading:`,
    `reply --drive ${c.sessionId} --recap "Drive mode recap — you said …; I did / answered …; next: … (or: nothing pending / waiting on X)"`,
    `It is posted in ${where}. After it the conversation is closed: no follow-ups or nudges unless the recap names a next step.`,
    '',
    'The conversation:',
    transcript,
  ].join('\n');
}

/**
 * The conversation an agent's reply belongs to: one it answers or is a
 * member of; a recap goes to one whose recap was asked for; otherwise the one
 * waiting for an answer, newest first.
 *
 * @param all - Local conversations
 * @param sessionId - Session
 * @param agentSession - Who replies
 * @param recap - It is the recap
 * @returns Conversation or undefined
 */
export function pickConversation(all: readonly DriveLocalConversation[], sessionId: string, agentSession: string, recap: boolean): DriveLocalConversation | undefined {
  const mine = all.filter((c) => c.sessionId === sessionId && !c.closedAt && (c.agentSession === agentSession || (c.members ?? []).includes(agentSession)));
  const waiting = (c: DriveLocalConversation): boolean => {
    const lastOwner = [...c.turns].reverse().find((t) => t.from === 'owner');
    const lastAgent = [...c.turns].reverse().find((t) => t.from === 'agent' && !t.interim);
    return !!lastOwner && (!lastAgent || Date.parse(lastAgent.at) < Date.parse(lastOwner.at));
  };
  const pref = recap ? mine.filter((c) => c.recapAskedAt) : mine.filter(waiting);
  const pool = pref.length > 0 ? pref : mine;
  const own = pool.filter((c) => c.agentSession === agentSession);
  const list = own.length > 0 ? own : pool;
  const lastAt = (c: DriveLocalConversation): number => Date.parse(c.turns[c.turns.length - 1]?.at ?? c.startedAt);
  return [...list].sort((a, b) => lastAt(b) - lastAt(a))[0];
}

let instance: DriveAgentService | null = null;

/** @returns The running service, or null */
export function getDriveAgentService(): DriveAgentService | null {
  return instance;
}

/**
 * Install the service (boot, tests).
 *
 * @param service - Service or null
 */
export function setDriveAgentService(service: DriveAgentService | null): void {
  instance = service;
}
