/**
 * Meetings P2b (crewly#1415): the meeting pack for a voice 1:1 meeting with
 * one agent — what the voice needs to speak as that agent. Pure: the wiring
 * (drive-meeting.wiring.ts) reads the sources, this module turns them into
 * the wire shape Cloud expects (crewly-services `auth/src/drive/meeting-agent.ts`).
 *
 * The pack holds:
 *  - the agent (name, role, team) and its latest handover (clipped);
 *  - its active and waiting work in plain words, from the status snapshot;
 *  - the last owner↔agent messages and recent decisions;
 *  - the agenda: open owner↔agent threads (Slack threads, Crewly chat
 *    threads, open decision cards), each `{threadRef, topic, state}` with
 *    state `waiting_on_owner` (a card waits on the owner), `question` (the
 *    agent asked and the owner has not answered) or `in_progress` (the owner
 *    asked and the agent still owes the answer, or said it is on it);
 *  - wiki pages relevant to the team and the agenda (read by the wiring).
 *
 * Only this agent's own conversations, cards and work go in. Everything
 * is made speakable, passed through the secret redactor and clipped, and the
 * whole pack is kept under {@link MEETING_CONSTANTS.PACK_MAX_TOKENS}.
 *
 * @module services/drive/drive-meeting-pack
 */

import { MEETING_CONSTANTS } from '../../constants.js';
import { redactSecrets } from '../../utils/secret-redactor.js';
import { clip, speakable } from '../briefing/briefing.utils.js';
import { slackThreadOfMetadata } from '../slack/slack-thread-key.js';
import type { BriefingSnapshot } from './drive-briefing.contract.js';

const C = MEETING_CONSTANTS;

/** Where an agenda thread stands. */
export type MeetingThreadState = 'waiting_on_owner' | 'question' | 'in_progress';

/** One line of a conversation, as the pack carries it. */
export interface MeetingLine {
  from: 'owner' | 'agent';
  text: string;
  at: string;
}

/** One agenda topic: an open owner↔agent thread. */
export interface MeetingAgendaEntry {
  threadRef: string;
  topic: string;
  state: MeetingThreadState;
  lastAt?: string;
  /** Where the thread is, in words (`Slack DM`, `Crewly chat`, `#launch`) */
  where?: string;
  recent?: MeetingLine[];
}

/** The pack, as posted to Cloud. */
export interface MeetingPackWire {
  v: 1;
  agent: { name: string; session: string; role?: string; team?: string };
  handover?: string;
  work: Array<{ title: string; status: string; last?: string }>;
  waiting: Array<{ kind: string; summary: string }>;
  messages: Array<MeetingLine & { where?: string }>;
  decisions: Array<{ question: string; answer: string; at: string }>;
  agenda: MeetingAgendaEntry[];
  wiki: Array<{ title: string; where: string; text: string }>;
  builtAt: string;
  estTokens: number;
}

/** An agent timeline row (chat-v2 `getAgentTimeline` item, the fields used). */
export interface MeetingTimelineRow {
  id: string;
  channelId: string;
  channelType?: string;
  channelName?: string;
  threadId?: string;
  senderType: string;
  /** `owner`, `agent`, `human`, `system` */
  senderKind?: string;
  senderId: string;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/** An owner decision card (the fields used). */
export interface MeetingDecisionSource {
  id: string;
  question: string;
  status: string;
  asker: string;
  requestedBy: string;
  options: Array<{ key: string; label: string }>;
  card?: { slackChannelId: string; messageTs: string; threadTs?: string };
  place?: { slackChannelId: string; threadTs?: string };
  chosenKey?: string;
  answerText?: string;
  ownerWords?: string;
  createdAt: string;
  updatedAt: string;
}

/** Everything a pack is built from. */
export interface MeetingPackSources {
  now: Date;
  agent: { session: string; name: string; role?: string; team?: string };
  handover?: string | null;
  snapshot?: BriefingSnapshot | null;
  /** The agent's timeline, any order */
  timeline: MeetingTimelineRow[];
  decisions: MeetingDecisionSource[];
  wiki: Array<{ title: string; where: string; text: string }>;
}

/** `[SLACK-THREAD:…]`, `[Drive mode · …]` and similar harness tags. */
const HARNESS_TAG = /\[(?:SLACK-THREAD|Drive mode[^\]]*|Meeting[^\]]*|TRIGGERED-BY[^\]]*)[^\]]*\]/gi;
/** A chat-v2 message id (uuid). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The agent asks the owner something. */
const ASKS = /[?？]\s*$|[?？]\s*\S{0,40}$|\b(should i|shall i|do you want|would you like|which (one|option)|can you (confirm|approve|check)|let me know|your call|ok to|okay to|approve)\b|要不要|可以吗|行吗|好吗|确认一下|请确认|选哪个|你看|您看|需要你|等你/i;
/** The agent says it is on it. */
const ON_IT = /\b(working on|on it|i'?ll|i will|in progress|will (send|post|share|finish|get back)|started|starting|looking into|digging|drafting)\b|正在|在做|在弄|在改|稍后|马上|我来|我去|处理中|进行中/i;

/**
 * Plain spoken words for one message: harness tags, links and markdown out,
 * secrets masked, clipped.
 *
 * @param text - Raw text
 * @param max - Longest result
 * @returns Clean text
 */
export function plainWords(text: string, max: number): string {
  const noTags = (text ?? '').replace(HARNESS_TAG, ' ');
  return clip(speakable(redactSecrets(noTags)).replace(/\s+/g, ' ').trim(), max);
}

/**
 * Rough token count: CJK characters one each, other text four characters a
 * token (the same estimate Cloud uses).
 *
 * @param text - Text
 * @returns Estimated tokens
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk += 1;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * The thread a timeline row belongs to, as a meeting thread ref; null for a
 * row that is not part of an owner↔agent thread (a room's top level).
 *
 * @param row - Timeline row
 * @returns `slack:<conversation>:<ts>`, `chat:<channel>:<root>` or `chat:<dm channel>`
 */
export function threadRefOfRow(row: MeetingTimelineRow): string | null {
  const slack = slackThreadOfMetadata(row.metadata);
  if (slack) return `slack:${slack.slackChannelId}:${slack.threadTs}`;
  if (row.threadId) return `chat:${row.channelId}:${row.threadId}`;
  if (row.channelType === 'dm') return `chat:${row.channelId}`;
  return null;
}

/**
 * Split a `chat:` thread ref: the channel, and the thread root when the last
 * segment is a message id.
 *
 * @param ref - Thread ref
 * @returns Channel + root, or null for a ref that is not `chat:`
 */
export function parseChatThreadRef(ref: string): { channelId: string; rootId?: string } | null {
  if (!ref.startsWith('chat:')) return null;
  const rest = ref.slice('chat:'.length);
  const cut = rest.lastIndexOf(':');
  if (cut > 0 && UUID.test(rest.slice(cut + 1))) return { channelId: rest.slice(0, cut), rootId: rest.slice(cut + 1) };
  return rest ? { channelId: rest } : null;
}

/**
 * Split a `slack:` thread ref.
 *
 * @param ref - Thread ref
 * @returns Slack conversation + thread ts, or null
 */
export function parseSlackThreadRef(ref: string): { slackChannelId: string; threadTs: string } | null {
  const m = /^slack:([A-Za-z0-9]{5,24}):(\d{6,12}(?:\.\d{1,8})?)$/.exec(ref);
  return m ? { slackChannelId: m[1], threadTs: m[2] } : null;
}

/** Who wrote a row, from the agent's side. */
function sideOf(row: MeetingTimelineRow, agentSession: string): 'owner' | 'agent' | null {
  if (row.senderType === 'system' || row.senderKind === 'system') return null;
  if (row.senderType === 'agent') return row.senderId === agentSession ? 'agent' : null;
  if (row.senderKind === 'agent' || row.senderKind === 'human') return null;
  return 'owner';
}

/** Where a thread is, in words. */
function whereOf(row: MeetingTimelineRow): string {
  const slack = slackThreadOfMetadata(row.metadata);
  if (row.channelType === 'dm') return slack ? 'Slack DM' : 'Crewly chat';
  const name = (row.channelName ?? '').trim();
  return name ? (slack ? `Slack #${name}` : `#${name}`) : slack ? 'Slack' : 'Crewly chat';
}

/**
 * Where an open conversation stands, or null when it is settled.
 *
 * @param lines - The conversation, oldest first
 * @returns State or null
 */
export function threadState(lines: readonly MeetingLine[]): MeetingThreadState | null {
  const last = lines[lines.length - 1];
  if (!last) return null;
  if (last.from === 'owner') return 'in_progress';
  if (ASKS.test(last.text)) return 'question';
  if (ON_IT.test(last.text)) return 'in_progress';
  return null;
}

/**
 * The agenda: open decision cards first, then open threads, newest first
 * within each state, at most {@link MEETING_CONSTANTS.AGENDA_MAX}.
 *
 * @param s - Sources
 * @returns Agenda entries
 */
export function buildAgenda(s: Pick<MeetingPackSources, 'now' | 'agent' | 'timeline' | 'decisions'>): MeetingAgendaEntry[] {
  const out: MeetingAgendaEntry[] = [];
  const seen = new Set<string>();
  const since = s.now.getTime() - C.AGENDA_WINDOW_MS;

  for (const d of s.decisions) {
    if (d.status !== 'open' || (d.asker !== s.agent.session && d.requestedBy !== s.agent.session)) continue;
    const ch = d.card?.slackChannelId ?? d.place?.slackChannelId;
    const ts = d.card ? (d.card.threadTs ?? d.card.messageTs) : d.place?.threadTs;
    if (!ch || !ts) continue;
    const ref = `slack:${ch}:${ts}`;
    if (seen.has(ref) || !parseSlackThreadRef(ref)) continue;
    seen.add(ref);
    const options = d.options.map((o) => o.label).filter(Boolean).slice(0, 4);
    out.push({
      threadRef: ref,
      topic: plainWords(d.question, C.TOPIC_MAX_CHARS),
      state: 'waiting_on_owner',
      lastAt: d.updatedAt || d.createdAt,
      where: 'decision card',
      ...(options.length ? { recent: [{ from: 'agent' as const, text: plainWords(`${d.question} Options: ${options.join(' / ')}`, C.TOPIC_RECENT_MAX_CHARS), at: d.createdAt }] } : {}),
    });
  }

  // Group the agent's owner conversations by thread.
  const threads = new Map<string, { rows: MeetingTimelineRow[]; sides: Set<string> }>();
  for (const row of s.timeline) {
    if (row.createdAt < since) continue;
    const side = sideOf(row, s.agent.session);
    if (!side || !row.content?.trim()) continue;
    // A meeting's own outcome, written in the owner's name, is not something new he raised.
    if (row.metadata?.source === C.SOURCE && row.metadata?.via === C.VIA) continue;
    const ref = threadRefOfRow(row);
    if (!ref) continue;
    const t = threads.get(ref) ?? { rows: [], sides: new Set<string>() };
    t.rows.push(row);
    t.sides.add(side);
    threads.set(ref, t);
  }
  const open: MeetingAgendaEntry[] = [];
  for (const [ref, t] of threads) {
    if (seen.has(ref)) continue;
    const dm = t.rows.some((r) => r.channelType === 'dm');
    // A room thread is on the agenda only when the owner and this agent both spoke in it.
    if (!dm && !(t.sides.has('owner') && t.sides.has('agent'))) continue;
    const rows = [...t.rows].sort((a, b) => a.createdAt - b.createdAt);
    const lines: MeetingLine[] = rows.map((r) => ({ from: sideOf(r, s.agent.session) as 'owner' | 'agent', text: plainWords(r.content, C.TOPIC_RECENT_MAX_CHARS), at: new Date(r.createdAt).toISOString() })).filter((l) => l.text);
    const state = threadState(lines);
    if (!state) continue;
    // A DM without threads is one long conversation: only its latest exchange is the topic.
    const tail = ref.startsWith('chat:') && !parseChatThreadRef(ref)?.rootId ? lines.slice(-4) : lines;
    const first = tail.find((l) => l.from === 'owner') ?? tail[0];
    const topic = clip(first?.text ?? '', C.TOPIC_MAX_CHARS);
    if (!topic) continue;
    open.push({ threadRef: ref, topic, state, lastAt: lines[lines.length - 1].at, where: whereOf(rows[rows.length - 1]), recent: tail.slice(-C.TOPIC_RECENT_MAX) });
  }
  const rank: Record<MeetingThreadState, number> = { waiting_on_owner: 0, question: 1, in_progress: 2 };
  open.sort((a, b) => rank[a.state] - rank[b.state] || Date.parse(b.lastAt ?? '') - Date.parse(a.lastAt ?? ''));
  return [...out, ...open].slice(0, C.AGENDA_MAX);
}

/**
 * The words to search the wiki with for the pack: the team, the role and
 * the agenda topics, at most 200 characters.
 *
 * @param agent - The agent
 * @param agenda - Its agenda
 * @returns Query, or '' when there is nothing to search for
 */
export function packWikiQuery(agent: MeetingPackSources['agent'], agenda: readonly MeetingAgendaEntry[]): string {
  const parts = [agent.team, agent.role, ...agenda.map((a) => a.topic)].filter((p): p is string => !!p && !!p.trim());
  let q = '';
  for (const p of parts) {
    const next = q ? `${q} ${p}` : p;
    if (next.length > 200) break;
    q = next;
  }
  return q.trim();
}

/** The chosen answer of a settled decision, in words. */
function answerOf(d: MeetingDecisionSource): string {
  const label = d.options.find((o) => o.key === d.chosenKey)?.label;
  return plainWords(d.ownerWords || d.answerText || label || '', 300);
}

/**
 * The pack text Cloud renders, for the size estimate (close enough to
 * Cloud's own rendering for budgeting).
 *
 * @param p - Pack
 * @returns Text
 */
export function packTextForBudget(p: MeetingPackWire): string {
  return JSON.stringify({ ...p, estTokens: 0 });
}

/**
 * Build the pack.
 *
 * @param s - Sources
 * @returns The pack, within the token budget
 */
export function buildMeetingPack(s: MeetingPackSources): MeetingPackWire {
  const agentName = s.agent.name;
  const snap = s.snapshot ?? null;
  const me = snap?.agents.find((a) => a.session === s.agent.session);
  const role = s.agent.role ?? me?.role;
  const team = s.agent.team ?? me?.team;

  const work: MeetingPackWire['work'] = [];
  if (me?.activity?.title) work.push({ title: plainWords(me.activity.title, 200), status: 'in_progress', last: `since ${me.activity.since}` });
  for (const item of snap?.items ?? []) {
    if (item.assignee !== agentName || item.status === 'done' || item.status === 'cancelled') continue;
    const title = plainWords(item.title, 200);
    if (!title || work.some((w) => w.title === title)) continue;
    work.push({ title, status: item.status, ...(item.last ? { last: plainWords(item.last, 300) } : {}) });
    if (work.length >= C.WORK_MAX) break;
  }
  const waiting = (snap?.waiting ?? [])
    .filter((w) => w.from === agentName)
    .slice(0, C.WAITING_MAX)
    .map((w) => ({ kind: w.kind, summary: plainWords(w.summary, 300) }))
    .filter((w) => w.summary);

  const since = s.now.getTime() - C.AGENDA_WINDOW_MS;
  const messages = s.timeline
    .filter((r) => r.createdAt >= since && !!sideOf(r, s.agent.session) && (r.channelType === 'dm' || !!r.threadId || !!slackThreadOfMetadata(r.metadata)))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-C.MESSAGES_MAX)
    .map((r) => ({ from: sideOf(r, s.agent.session) as 'owner' | 'agent', text: plainWords(r.content, C.MESSAGE_MAX_CHARS), at: new Date(r.createdAt).toISOString(), where: whereOf(r) }))
    .filter((m) => m.text);

  const decisionsSince = s.now.getTime() - C.DECISIONS_WINDOW_MS;
  const decisions = s.decisions
    .filter((d) => d.status !== 'open' && (d.asker === s.agent.session || d.requestedBy === s.agent.session) && Date.parse(d.updatedAt) >= decisionsSince)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((d) => ({ question: plainWords(d.question, 300), answer: answerOf(d), at: d.updatedAt }))
    .filter((d) => d.question && d.answer)
    .slice(0, C.DECISIONS_MAX);

  const handover = s.handover ? clip(redactSecrets(s.handover).trim(), C.HANDOVER_MAX_CHARS) : '';
  const pack: MeetingPackWire = {
    v: 1,
    agent: { name: agentName, session: s.agent.session, ...(role ? { role } : {}), ...(team ? { team } : {}) },
    ...(handover ? { handover } : {}),
    work,
    waiting,
    messages,
    decisions,
    agenda: buildAgenda(s),
    wiki: s.wiki.slice(0, C.WIKI_PAGES_MAX).map((w) => ({ title: clip(w.title, 160), where: clip(w.where, 160), text: clip(redactSecrets(w.text), C.WIKI_PAGE_MAX_CHARS) })),
    builtAt: s.now.toISOString(),
    estTokens: 0,
  };
  return fitBudget(pack);
}

/**
 * Trim a pack to the token budget: wiki pages first, then old messages,
 * then the handover's tail.
 *
 * @param pack - Pack (changed in place)
 * @returns The same pack, with `estTokens`
 */
export function fitBudget(pack: MeetingPackWire): MeetingPackWire {
  const size = (): number => estimateTokens(packTextForBudget(pack));
  while (size() > C.PACK_MAX_TOKENS && pack.wiki.length) pack.wiki.pop();
  while (size() > C.PACK_MAX_TOKENS && pack.messages.length > 5) pack.messages.shift();
  while (size() > C.PACK_MAX_TOKENS && pack.handover && pack.handover.length > 500) pack.handover = clip(pack.handover, Math.floor(pack.handover.length * 0.7));
  pack.estTokens = size();
  return pack;
}
