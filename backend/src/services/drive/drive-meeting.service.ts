/**
 * DriveMeetingService — the machine side of a voice 1:1 meeting with one
 * agent (Meetings P2b, crewly#1415). Cloud hosts the meeting; this machine
 * answers what only it can, for that agent only:
 *
 *  - `buildPack` (`op:'meeting_pack'`): the agent's meeting pack — role,
 *    team, handover, work, the last owner↔agent messages, recent decisions,
 *    the agenda of open threads and relevant wiki pages
 *    (drive-meeting-pack.ts);
 *  - `searchWiki` (`op:'wiki_search'`): BM25 over the agent's own team and
 *    project vaults, top snippets in plain words, with the time it took;
 *  - `writeBack` (a delivery carrying `writeBack`): a decision, answer, task
 *    or note from the meeting is written into the thread it belongs to — a
 *    Slack thread (posted by the agent's bot, recorded in Crewly chat), a
 *    Crewly chat thread, or the open decision card it answers — and the
 *    agent gets it like any message from the owner. A new topic starts a
 *    new thread, which later write-backs on that topic reuse.
 *
 * Nothing the owner or the agent says is written to this machine's server
 * logs: only counts, sizes and timings.
 *
 * @module services/drive/drive-meeting.service
 */

import { performance } from 'node:perf_hooks';
import { MEETING_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { clip } from '../briefing/briefing.utils.js';
import { redactSecrets } from '../../utils/secret-redactor.js';
import type { BriefingSnapshot } from './drive-briefing.contract.js';
import type { DriveMeetingPackFetch, DriveWikiFetch, DriveWriteBack } from './drive-cloud.contract.js';
import {
  buildMeetingPack,
  packWikiQuery,
  parseChatThreadRef,
  parseSlackThreadRef,
  plainWords,
  buildAgenda,
  type MeetingDecisionSource,
  type MeetingPackWire,
  type MeetingTimelineRow,
} from './drive-meeting-pack.js';

const C = MEETING_CONSTANTS;

/** A vault the agent may read. */
export interface MeetingVault {
  vaultPath: string;
  label: string;
}

/** A wiki hit, as the machine reads it. */
export interface MeetingWikiPageHit {
  title: string;
  where: string;
  text: string;
  /** The page file, for the pack's longer excerpt */
  absPath?: string;
}

/** Collaborators (wired in index.ts; fakes in tests). */
export interface DriveMeetingDeps {
  /** The agent's chat timeline since a time (its DMs, rooms and threads) */
  timeline: (agentSession: string, sinceMs: number) => Promise<MeetingTimelineRow[]>;
  /** Owner decision cards (open and settled) */
  decisions: () => Promise<MeetingDecisionSource[]>;
  /** The latest status snapshot (work and waiting items), when there is one */
  snapshot?: () => Promise<BriefingSnapshot | null>;
  /** The agent's latest handover text, when there is one */
  handover: (agentSession: string) => Promise<string | null>;
  /** The vaults the agent may read: its teams' and their projects' (never the global wiki) */
  vaults: (agentSession: string) => Promise<MeetingVault[]>;
  /** BM25 over those vaults as that agent reads them (page visibility by its role), best first */
  searchWiki: (vaults: MeetingVault[], query: string, agentSession: string) => Promise<MeetingWikiPageHit[]>;
  /** A page's text (frontmatter removed), for the pack */
  readPage?: (absPath: string) => Promise<string | null>;
  /** Settle an open decision card with the owner's words; false when the words settle nothing */
  answerDecision?: (decisionId: string, text: string) => Promise<boolean>;
  /** The agent's Slack DM, when it has one its own bot can post in */
  slackDmOf: (agentSession: string) => { slackChannelId: string; chatChannelId: string } | null;
  /** The Crewly chat channel a Slack conversation is mirrored into */
  chatChannelOfSlack: (slackChannelId: string) => { chatChannelId: string; dm: boolean } | null;
  /** The chat thread root of a Slack thread in a room (rooms thread their Slack threads; DMs do not) */
  slackRootId: (chatChannelId: string, threadTs: string) => string | null;
  /** Post in Slack as the agent (its bot in a DM; in a room the agent's identity); returns the message ts */
  postSlack: (input: { agentSession: string; slackChannelId: string; threadTs?: string; text: string }) => Promise<string | null>;
  /** The owner's DM channel with the agent in Crewly chat */
  ownerDmChannel: (agentSession: string) => string;
  /** Record the owner's turn in Crewly chat and deliver it to the agent */
  recordOwnerTurn: (input: { agentSession: string; channelId: string; threadId?: string; text: string; metadata: MeetingRowMetadata }) => Promise<{ messageId: string }>;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** Metadata on a chat row a write-back records. */
export interface MeetingRowMetadata {
  source: typeof MEETING_CONSTANTS.SOURCE;
  [key: string]: unknown;
}

/** What a write-back did. */
export interface MeetingWriteBackResult {
  /** The thread it went into (a new topic's new thread included) */
  threadRef?: string;
  via: 'decision' | 'slack' | 'chat';
}

const KIND_LABEL: Record<DriveWriteBack['kind'], string> = {
  decision: 'Decision',
  answer: 'Answer',
  task: 'New task',
  note: 'Note',
};

/** The machine side of a 1:1 meeting — see module docs. */
export class DriveMeetingService {
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  /** New-topic threads by `<sessionId>\u0000<topic>`, so a second write-back reuses the first one's thread */
  private readonly newThreads = new Map<string, string>();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: DriveMeetingDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('DriveMeeting');
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Build the meeting pack for one agent. Each source is read on its own; a
   * failing one is left empty, never the whole pack.
   *
   * @param req - Who the meeting is with
   * @returns The pack (within the token budget)
   */
  async buildPack(req: DriveMeetingPackFetch): Promise<MeetingPackWire> {
    const started = performance.now();
    const now = this.now();
    const agent = { session: req.agentSession, name: req.name, ...(req.role ? { role: req.role } : {}), ...(req.team ? { team: req.team } : {}) };
    const [timeline, decisions, snapshot, handover] = await Promise.all([
      read(() => this.deps.timeline(req.agentSession, now.getTime() - C.AGENDA_WINDOW_MS), [] as MeetingTimelineRow[]),
      read(() => this.deps.decisions(), [] as MeetingDecisionSource[]),
      read(async () => (this.deps.snapshot ? this.deps.snapshot() : null), null as BriefingSnapshot | null),
      read(() => this.deps.handover(req.agentSession), null as string | null),
    ]);
    // Wiki pages for the team and the agenda topics.
    const agenda = buildAgenda({ now, agent, timeline, decisions });
    const query = packWikiQuery(agent, agenda);
    let wiki: Array<{ title: string; where: string; text: string }> = [];
    if (query) {
      const vaults = await read(() => this.deps.vaults(req.agentSession), [] as MeetingVault[]);
      const hits = vaults.length ? await read(() => this.deps.searchWiki(vaults, query, req.agentSession), [] as MeetingWikiPageHit[]) : [];
      wiki = await Promise.all(
        hits.slice(0, C.WIKI_PAGES_MAX).map(async (h) => {
          const page = h.absPath && this.deps.readPage ? await read(() => (this.deps.readPage as (p: string) => Promise<string | null>)(h.absPath as string), null as string | null) : null;
          return { title: h.title, where: h.where, text: clip((page ?? h.text).trim(), C.WIKI_PAGE_MAX_CHARS) };
        }),
      );
    }
    const pack = buildMeetingPack({ now, agent, handover, snapshot, timeline, decisions, wiki });
    this.logger.info('Meeting pack built', {
      agent: req.agentSession,
      ms: Math.round(performance.now() - started),
      estTokens: pack.estTokens,
      agenda: pack.agenda.length,
      messages: pack.messages.length,
      work: pack.work.length,
      wiki: pack.wiki.length,
      handover: !!pack.handover,
    });
    return pack;
  }

  /**
   * Live wiki search for the meeting: BM25 over the agent's own vaults.
   *
   * @param req - Agent + query
   * @returns Top hits in plain words, and how long the search took (ms)
   */
  async searchWiki(req: DriveWikiFetch): Promise<{ hits: Array<{ title: string; where: string; text: string }>; ms: number }> {
    const started = performance.now();
    const vaults = await read(() => this.deps.vaults(req.agentSession), [] as MeetingVault[]);
    const raw = vaults.length ? await read(() => this.deps.searchWiki(vaults, req.query, req.agentSession), [] as MeetingWikiPageHit[]) : [];
    const hits = raw
      .slice(0, C.WIKI_HITS_MAX)
      .map((h) => ({ title: clip(h.title, 160), where: clip(h.where, 160), text: plainWords(h.text, C.WIKI_HIT_MAX_CHARS) }))
      .filter((h) => h.title && h.text);
    const ms = Math.round(performance.now() - started);
    this.logger.info('Meeting wiki search', { agent: req.agentSession, vaults: vaults.length, hits: hits.length, ms });
    return { hits, ms };
  }

  /**
   * Write one meeting outcome into the thread it belongs to and hand it to
   * the agent.
   *
   * @param input - Session, agent, the owner's words and where they go
   * @returns Where it was written
   */
  async writeBack(input: { sessionId: string; agentSession: string; text: string; writeBack: DriveWriteBack }): Promise<MeetingWriteBackResult> {
    const w = input.writeBack;
    const words = clip(redactSecrets(input.text.trim()), C.WRITE_BACK_MAX_CHARS);
    const key = `${input.sessionId}\u0000${(w.newTopic ?? w.topic).toLowerCase()}`;
    const ref = w.threadRef ?? this.newThreads.get(key);
    const line = `From our voice meeting — ${KIND_LABEL[w.kind]}: ${words}`;
    const meta: MeetingRowMetadata = { source: C.SOURCE, via: C.VIA, inputMode: 'voice', meetingSessionId: input.sessionId, meetingKind: w.kind };

    if (ref) {
      const slack = parseSlackThreadRef(ref);
      if (slack) {
        // An open card in that thread: the owner's words settle it.
        if ((w.kind === 'decision' || w.kind === 'answer') && (await this.settleCard(input.agentSession, ref, words))) {
          return { threadRef: ref, via: 'decision' };
        }
        await this.writeSlack(input.agentSession, slack.slackChannelId, slack.threadTs, line, meta);
        return { threadRef: ref, via: 'slack' };
      }
      const chat = parseChatThreadRef(ref);
      if (chat) {
        await this.deps.recordOwnerTurn({ agentSession: input.agentSession, channelId: chat.channelId, ...(chat.rootId ? { threadId: chat.rootId } : {}), text: line, metadata: meta });
        return { threadRef: ref, via: 'chat' };
      }
    }

    // A new topic: a new thread, in Slack when the agent has a DM there.
    const topic = clip(w.newTopic ?? w.topic, C.TOPIC_MAX_CHARS);
    const opening = `${topic}\n${line}`;
    const dm = this.deps.slackDmOf(input.agentSession);
    let made: MeetingWriteBackResult | null = null;
    if (dm) {
      const ts = await this.deps.postSlack({ agentSession: input.agentSession, slackChannelId: dm.slackChannelId, text: opening }).catch(() => null);
      if (ts) {
        await this.deps.recordOwnerTurn({
          agentSession: input.agentSession,
          channelId: dm.chatChannelId,
          text: opening,
          metadata: { ...meta, slackChannelId: dm.slackChannelId, slackTs: ts, slackThreadTs: ts, slackAlreadyPosted: true },
        });
        made = { threadRef: `slack:${dm.slackChannelId}:${ts}`, via: 'slack' };
      }
    }
    if (!made) {
      const channelId = this.deps.ownerDmChannel(input.agentSession);
      const { messageId } = await this.deps.recordOwnerTurn({ agentSession: input.agentSession, channelId, text: opening, metadata: meta });
      made = { threadRef: `chat:${channelId}:${messageId}`, via: 'chat' };
    }
    if (made.threadRef) this.remember(key, made.threadRef);
    return made;
  }

  /** Post in a Slack thread as the agent and record it in Crewly chat. */
  private async writeSlack(agentSession: string, slackChannelId: string, threadTs: string, text: string, meta: MeetingRowMetadata): Promise<void> {
    const ts = await this.deps.postSlack({ agentSession, slackChannelId, threadTs, text }).catch((err: unknown) => {
      this.logger.warn('Meeting write-back: Slack post failed', { agent: agentSession, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    const chat = this.deps.chatChannelOfSlack(slackChannelId);
    const slackMeta: MeetingRowMetadata = { ...meta, slackChannelId, slackThreadTs: threadTs, ...(ts ? { slackTs: ts, slackAlreadyPosted: true } : {}) };
    if (chat) {
      const root = chat.dm ? null : this.deps.slackRootId(chat.chatChannelId, threadTs);
      await this.deps.recordOwnerTurn({ agentSession, channelId: chat.chatChannelId, ...(root ? { threadId: root } : {}), text, metadata: slackMeta });
      return;
    }
    // Not mirrored here: the agent still gets it, in its DM.
    await this.deps.recordOwnerTurn({ agentSession, channelId: this.deps.ownerDmChannel(agentSession), text, metadata: slackMeta });
  }

  /** Settle the agent's open card in that thread, when there is one and the words answer it. */
  private async settleCard(agentSession: string, ref: string, words: string): Promise<boolean> {
    if (!this.deps.answerDecision) return false;
    const decisions = await read(() => this.deps.decisions(), [] as MeetingDecisionSource[]);
    const card = decisions.find((d) => {
      if (d.status !== 'open' || (d.asker !== agentSession && d.requestedBy !== agentSession)) return false;
      const ch = d.card?.slackChannelId ?? d.place?.slackChannelId;
      const ts = d.card ? (d.card.threadTs ?? d.card.messageTs) : d.place?.threadTs;
      return !!ch && !!ts && `slack:${ch}:${ts}` === ref;
    });
    if (!card) return false;
    return this.deps.answerDecision(card.id, words).catch(() => false);
  }

  private remember(key: string, ref: string): void {
    this.newThreads.set(key, ref);
    while (this.newThreads.size > C.NEW_THREADS_MAX) {
      const oldest = this.newThreads.keys().next().value;
      if (oldest === undefined) break;
      this.newThreads.delete(oldest);
    }
  }
}

/** Read a source; a failure gives the fallback. */
async function read<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
