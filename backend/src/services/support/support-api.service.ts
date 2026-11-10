/**
 * The support API on the instance (crewly#1558 slice 2).
 *
 * `/api/support/*` is served IN PROCESS to a {@link SupportCaller} only. It is
 * deliberately not an Express route: no HTTP request (local agent, dashboard,
 * relay owner call) can reach it, so no owner or local credential can be
 * turned into a support identity and no support identity into an owner one.
 * The support relay is the single caller.
 *
 * Endpoints (paths relative to `/api`):
 * - `GET  /support/whoami`                              the grant as the instance sees it
 * - `GET  /support/conversations?limit=&archived=1`     chat-v2 conversations (Slack mirrors included)
 * - `GET  /support/conversations/:id/messages?limit=&cursor=&direction=`  one page of messages
 * - `GET  /support/agents`                              orchestrator, teams and members with status
 * - `GET  /support/errors?limit=`                       WARN / ERROR lines from the service log
 * - `GET  /support/settings`                            allowlisted non-secret settings
 * - `POST /support/agents/:session/restart`             admin only: restart one agent
 *
 * Every text goes through {@link redactForSupport}: secrets always scrubbed,
 * private content withheld unless the grant includes it.
 *
 * `specs/2026-11-10-support-access-instance.md`
 *
 * @module services/support/support-api.service
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import {
  CONVERSATION_LOG_CONSTANTS,
  ORCHESTRATOR_SESSION_NAME,
  SHARED_CHANNEL_CONSTANTS,
  SLACK_AGENT_DM_CONSTANTS,
  SUPPORT_ACCESS_CONSTANTS,
} from '../../constants.js';
import { API_KEY_PROVIDERS, type CrewlySettings } from '../../types/settings.types.js';
import type { ChatChannelDTO, ChatMessageListResult, ChatPrincipal } from '../chat-v2/types.js';
import { redactForSupport, scrubSupportSecrets } from './support-redaction.js';
import { roleAllowsMethod, splitSupportPath, type SupportApiRequest, type SupportApiResponse, type SupportCaller } from './support.types.js';

const C = SUPPORT_ACCESS_CONSTANTS;

/** The chat-v2 reads the API uses. */
export interface SupportChatSource {
  listChannels(args: { principal: ChatPrincipal; includeArchived?: boolean; limit?: number }): ChatChannelDTO[];
  listMessages(args: { channelId: string; principal: ChatPrincipal; cursor?: string | null; limit?: number; direction?: 'backward' | 'forward' }): ChatMessageListResult;
}

/** A team member as the API needs it. */
export interface SupportTeamMember {
  id: string;
  name: string;
  role?: string;
  sessionName?: string;
  agentStatus?: string;
  workingStatus?: string;
  runtimeType?: string;
}

/** A team as the API needs it. */
export interface SupportTeam {
  id: string;
  name: string;
  members?: SupportTeamMember[];
}

/** The orchestrator as the API needs it. */
export interface SupportOrchestrator {
  sessionName: string;
  agentStatus?: string;
  workingStatus?: string;
  runtimeType?: string;
  readyAt?: string;
}

/** Collaborators (all injectable). */
export interface SupportApiDeps {
  chat: () => SupportChatSource | null;
  teams: () => Promise<SupportTeam[]>;
  orchestrator: () => Promise<SupportOrchestrator | null>;
  settings: () => Promise<CrewlySettings>;
  /** The end of the service log (default: last ERROR_TAIL_BYTES of `<CREWLY_HOME>/logs/service.log`) */
  readLogTail: () => Promise<string>;
  /** Restart one agent through the existing restart path; resolves true when it came back */
  restartAgent: (session: string) => Promise<boolean>;
  /** Whether the owner stopped this agent on purpose (support never overrides that) */
  isOwnerStopped: (session: string) => boolean;
  /** Whether the agent's team is paused by the owner */
  isSessionPaused: (session: string) => boolean;
}

/** Settings a support caller may read, by section. Never tokens, keys, commands, paths or env. */
export const SUPPORT_SETTINGS_ALLOWLIST: Readonly<Record<'general' | 'chat' | 'skills', readonly string[]>> = {
  general: [
    'defaultRuntime',
    'autoStartOrchestrator',
    'autoRecoverHungOrchestrator',
    'checkInIntervalMinutes',
    'maxConcurrentAgents',
    'verboseLogging',
    'autoResumeOnRestart',
    'announceOnBoot',
    'autoUpdate',
    'keepAwakeOnPower',
    'freshConversationPerTask',
    'agentIdleTimeoutMinutes',
    'pressureMaxRunningAgents',
    'pressureIdleTimeoutMinutes',
    'enableProactiveCompact',
    'enableThresholdCompact',
    'enableSelfEvolution',
    'tokenTracking',
    'enableAuditor',
    'autonomyTickIntervalMinutes',
  ],
  chat: ['showRawTerminalOutput', 'enableTypingIndicator', 'maxMessageHistory', 'autoScrollToBottom', 'showTimestamps'],
  skills: ['enableBrowserAutomation', 'enableScriptExecution', 'skillExecutionTimeoutMs'],
};

/** The owner principal chat-v2 reads run under (single-user OSS). */
const OWNER_PRINCIPAL: ChatPrincipal = { userId: SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID, source: 'oss' };

/**
 * A JSON answer.
 *
 * @param status - HTTP status
 * @param body - Body
 * @returns Response
 */
function answer(status: number, body: unknown): SupportApiResponse {
  return { status, body };
}

/**
 * A refusal answer.
 *
 * @param status - HTTP status
 * @param code - Stable code
 * @param error - English reason
 * @returns Response
 */
export function supportError(status: number, code: string, error: string): SupportApiResponse {
  return answer(status, { success: false, code, error });
}

/**
 * A bounded integer query parameter.
 *
 * @param raw - Query value
 * @param fallback - Default
 * @param max - Upper bound
 * @returns Integer in 1..max
 */
function boundedInt(raw: string | null, fallback: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Where a conversation lives, from its id.
 *
 * @param id - chat-v2 channel id
 * @returns `slack`, `whatsapp`, `telegram`, `google-chat`, `shared` or `crewly`
 */
export function conversationSource(id: string): string {
  const P = CONVERSATION_LOG_CONSTANTS.CHANNEL_PREFIXES;
  if (id.startsWith(P.SLACK)) return 'slack';
  if (id.startsWith(P.WHATSAPP)) return 'whatsapp';
  if (id.startsWith(P.TELEGRAM)) return 'telegram';
  if (id.startsWith(P.GOOGLE_CHAT)) return 'google-chat';
  if (id.startsWith(SHARED_CHANNEL_CONSTANTS.CHAT_CHANNEL_PREFIX)) return 'shared';
  return 'crewly';
}

/**
 * Pick allowlisted keys of a settings section.
 *
 * @param section - Section object
 * @param keys - Allowed keys
 * @returns Only those keys whose values are plain scalars
 */
function pick(section: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!section || typeof section !== 'object') return out;
  for (const k of keys) {
    const v = (section as Record<string, unknown>)[k];
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Read the end of the service log.
 *
 * @param file - Log path
 * @param bytes - How many bytes from the end
 * @returns Text ('' when missing)
 */
export async function readFileTail(file: string, bytes: number): Promise<string> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    // Drop the first, probably partial, line when the read started mid-file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The default service log path.
 *
 * @param crewlyHome - CREWLY_HOME
 * @returns `<home>/logs/service.log`
 */
export function serviceLogPath(crewlyHome: string): string {
  return path.join(crewlyHome, C.SERVICE_LOG_DIR, C.SERVICE_LOG_FILE);
}

/**
 * Serves `/api/support/*` to a support caller, in process.
 */
export class SupportApiService {
  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: SupportApiDeps) {}

  /**
   * Answer one support request. Never throws: an unexpected failure is a 500
   * whose message is scrubbed of secrets.
   *
   * @param caller - The relay-vouched grantee (never the owner)
   * @param request - Method, path under `/api`, body
   * @returns Status and body for the `api_response`
   */
  async handle(caller: SupportCaller, request: SupportApiRequest): Promise<SupportApiResponse> {
    if (caller?.kind !== 'support') return supportError(403, C.CODES.BAD_REQUEST, 'Not a support caller');
    if (!roleAllowsMethod(caller.role, request.method)) {
      return supportError(403, C.CODES.METHOD, `A ${caller.role} grant cannot send ${request.method}`);
    }
    const { segments, query } = splitSupportPath(request.path);
    try {
      if (request.method === 'GET') {
        if (segments.length === 1 && segments[0] === 'whoami') return this.whoami(caller);
        if (segments.length === 1 && segments[0] === 'conversations') return this.conversations(caller, query);
        if (segments.length === 3 && segments[0] === 'conversations' && segments[2] === 'messages') return this.messages(caller, segments[1], query);
        if (segments.length === 1 && segments[0] === 'agents') return await this.agents();
        if (segments.length === 1 && segments[0] === 'errors') return await this.errors(caller, query);
        if (segments.length === 1 && segments[0] === 'settings') return await this.settingsView();
      }
      if (request.method === 'POST' && segments.length === 3 && segments[0] === 'agents' && segments[2] === 'restart') {
        // Admin only, whatever the method table says.
        if (caller.role !== 'admin') return supportError(403, C.CODES.METHOD, 'Only an admin grant can restart an agent');
        return await this.restart(segments[1]);
      }
      return supportError(404, C.CODES.NOT_FOUND, `No support endpoint ${request.method} /api${request.path.split('?')[0]}`);
    } catch (error) {
      const message = scrubSupportSecrets(error instanceof Error ? error.message : String(error));
      return supportError(500, C.CODES.UNAVAILABLE, message);
    }
  }

  /** `GET /support/whoami`. */
  private whoami(caller: SupportCaller): SupportApiResponse {
    return answer(200, {
      success: true,
      data: { grantId: caller.grantId, role: caller.role, includePrivate: caller.includePrivate, granteeEmail: caller.granteeEmail },
    });
  }

  /** `GET /support/conversations`. */
  private conversations(caller: SupportCaller, query: URLSearchParams): SupportApiResponse {
    const chat = this.deps.chat();
    if (!chat) return supportError(503, C.CODES.UNAVAILABLE, 'Chat is not ready on this instance');
    const limit = boundedInt(query.get('limit'), C.DEFAULT_CONVERSATIONS, C.MAX_CONVERSATIONS);
    const includeArchived = query.get('archived') === '1';
    const channels = chat.listChannels({ principal: OWNER_PRINCIPAL, includeArchived, limit: C.MAX_CONVERSATIONS });
    const sorted = [...channels].sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)).slice(0, limit);
    const conversations = sorted.map((ch) => {
      const name = redactForSupport(ch.name, { includePrivate: caller.includePrivate }).text;
      return {
        id: ch.id,
        name,
        type: ch.type,
        source: conversationSource(ch.id),
        ...(ch.agentSession ? { agentSession: ch.agentSession } : {}),
        ...(ch.teamId ? { teamId: ch.teamId } : {}),
        createdAt: ch.createdAt,
        lastMessageAt: ch.lastMessageAt ?? null,
        archived: Boolean(ch.archivedAt),
        ...(ch.external ? { external: true } : {}),
      };
    });
    return answer(200, { success: true, data: { conversations } });
  }

  /** `GET /support/conversations/:id/messages`. */
  private messages(caller: SupportCaller, channelId: string, query: URLSearchParams): SupportApiResponse {
    const chat = this.deps.chat();
    if (!chat) return supportError(503, C.CODES.UNAVAILABLE, 'Chat is not ready on this instance');
    const limit = boundedInt(query.get('limit'), C.DEFAULT_MESSAGES, C.MAX_MESSAGES);
    const direction = query.get('direction') === 'forward' ? 'forward' : 'backward';
    let page: ChatMessageListResult;
    try {
      page = chat.listMessages({ channelId, principal: OWNER_PRINCIPAL, cursor: query.get('cursor'), limit, direction });
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status === 404 || status === 403) return supportError(404, C.CODES.NOT_FOUND, `No conversation ${channelId}`);
      throw error;
    }
    const messages = page.messages.map((m) => {
      const { text, withheld } = redactForSupport(m.content, { includePrivate: caller.includePrivate, metadata: m.metadata, maxChars: C.MAX_MESSAGE_CHARS });
      return {
        id: m.id,
        seq: m.seq,
        ...(m.threadId ? { threadId: m.threadId } : {}),
        senderType: m.senderType,
        senderId: m.senderId,
        createdAt: m.createdAt,
        content: text,
        withheld,
        attachments: m.attachments?.length ?? 0,
        ...(m.replyCount ? { replyCount: m.replyCount } : {}),
      };
    });
    return answer(200, {
      success: true,
      data: { conversationId: page.channelId, messages, nextCursor: page.nextCursor, prevCursor: page.prevCursor },
    });
  }

  /** `GET /support/agents`. */
  private async agents(): Promise<SupportApiResponse> {
    const [orc, teams] = await Promise.all([this.deps.orchestrator().catch(() => null), this.deps.teams()]);
    return answer(200, {
      success: true,
      data: {
        orchestrator: orc
          ? {
              sessionName: orc.sessionName,
              agentStatus: orc.agentStatus ?? null,
              workingStatus: orc.workingStatus ?? null,
              runtimeType: orc.runtimeType ?? null,
              readyAt: orc.readyAt ?? null,
            }
          : null,
        teams: teams.map((t) => ({
          id: t.id,
          name: t.name,
          members: (t.members ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            role: m.role ?? null,
            sessionName: m.sessionName || null,
            agentStatus: m.agentStatus ?? null,
            workingStatus: m.workingStatus ?? null,
            runtimeType: m.runtimeType ?? null,
            ownerStopped: m.sessionName ? this.deps.isOwnerStopped(m.sessionName) : false,
            paused: m.sessionName ? this.deps.isSessionPaused(m.sessionName) : false,
          })),
        })),
      },
    });
  }

  /** `GET /support/errors`. */
  private async errors(caller: SupportCaller, query: URLSearchParams): Promise<SupportApiResponse> {
    const limit = boundedInt(query.get('limit'), C.DEFAULT_ERROR_LINES, C.MAX_ERROR_LINES);
    const tail = await this.deps.readLogTail();
    const lines = tail
      .split('\n')
      .filter((l) => C.ERROR_LINE_PATTERN.test(l))
      .slice(-limit)
      .map((l) => redactForSupport(l, { includePrivate: caller.includePrivate, maxChars: C.MAX_ERROR_LINE_CHARS }).text);
    return answer(200, { success: true, data: { source: C.SERVICE_LOG_FILE, lines } });
  }

  /** `GET /support/settings`. */
  private async settingsView(): Promise<SupportApiResponse> {
    const s = await this.deps.settings();
    const configured: Record<string, boolean> = {};
    for (const p of API_KEY_PROVIDERS) configured[p] = Boolean(s.apiKeys?.global?.[p]);
    return answer(200, {
      success: true,
      data: {
        general: pick(s.general, SUPPORT_SETTINGS_ALLOWLIST.general),
        chat: pick(s.chat, SUPPORT_SETTINGS_ALLOWLIST.chat),
        skills: pick(s.skills, SUPPORT_SETTINGS_ALLOWLIST.skills),
        apiKeysConfigured: configured,
      },
    });
  }

  /** `POST /support/agents/:session/restart` (admin). */
  private async restart(session: string): Promise<SupportApiResponse> {
    const known = session === ORCHESTRATOR_SESSION_NAME || (await this.deps.teams()).some((t) => (t.members ?? []).some((m) => m.sessionName === session));
    if (!known) return supportError(404, C.CODES.NOT_FOUND, `No agent ${session}`);
    if (this.deps.isOwnerStopped(session) || this.deps.isSessionPaused(session)) {
      return supportError(409, C.CODES.AGENT_STOPPED_BY_OWNER, `The owner stopped or paused ${session}; only the owner can start it again`);
    }
    const ok = await this.deps.restartAgent(session);
    return ok
      ? answer(200, { success: true, data: { session, restarted: true } })
      : supportError(500, C.CODES.UNAVAILABLE, `${session} did not come back after the restart`);
  }
}
