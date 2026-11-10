/**
 * Colleague messages: one agent writes to another agent of the same Crewly
 * account, on this machine or any other.
 *
 * Send: the name is resolved against the account directory. A colleague on this
 * machine gets the message through the normal local delivery (a stopped agent:
 * queued and woken). A colleague on another machine gets a `colleague_message`
 * over the Cloud relay queue (store-and-forward, same account only).
 * Receive: the wire message is checked (it must come from a machine of this
 * account, once, within the loop cap), framed as "a colleague, not the owner"
 * and delivered to the target agent.
 * Both sides record the exchange in their local chat history, never in an
 * owner thread.
 *
 * Pure orchestration: every side effect is a dependency, wired in
 * `colleague.wiring.ts`.
 *
 * @module services/colleague/colleague-message.service
 */

import { randomUUID } from 'crypto';
import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';
import type { DirectoryEntry } from '../slack/slack-directory.service.js';
import { ColleagueLoopGuard } from './colleague-loop-guard.js';
import { colleagueLabel, describeCandidates, formatColleagueMessage } from './colleague-framing.js';
import { isColleagueWireMessage, type ColleagueSendResult, type ColleagueWireMessage } from './colleague-message.types.js';
import { resolveColleague } from './colleague-resolver.js';

/** One row for the local chat history. */
export interface ColleagueRecord {
  /** The local agent the exchange belongs to */
  agentSession: string;
  /** Stable key of the colleague (`instanceId:session`) */
  peerKey: string;
  /** `Fern (SteamFun, iriss-air.lan)` */
  peerLabel: string;
  direction: 'in' | 'out';
  messageId: string;
  text: string;
  extra?: Record<string, unknown>;
}

/** Outcome of handing a wire message to the relay. */
export type RemoteSendOutcome = { ok: true } | { ok: false; code: 'cloud_unavailable' | 'machine_unknown' | 'send_failed'; error: string };

/** What the service needs from the rest of Crewly. */
export interface ColleagueDeps {
  /** This machine's Cloud identity */
  self(): Promise<{ instanceId: string; deviceName: string }>;
  /** The account directory (every agent, every machine); null when Cloud is not reachable */
  listDirectory(): Promise<DirectoryEntry[] | null>;
  /** Agents of this machine, for when the directory is not reachable */
  listLocalAgents(): Promise<DirectoryEntry[]>;
  /** A local agent's name and team; null when the session is not an agent of this machine */
  describeLocal(session: string): Promise<{ name: string; team?: string } | null>;
  /** Hand text to a local agent: delivered now, or queued (and the agent started) when it is down */
  deliverLocal(session: string, text: string): Promise<{ success: boolean; queued?: boolean; error?: string }>;
  /** Put a wire message on the relay for another machine */
  sendRemote(instanceId: string, wire: ColleagueWireMessage): Promise<RemoteSendOutcome>;
  /** Whether a machine is one of this account's (from the Cloud device list) */
  isAccountMachine(instanceId: string): boolean;
  /** Whether the machine is online now; null when unknown */
  isMachineOnline?(instanceId: string): boolean | null;
  /** Whether the owner paused the team of a local agent */
  isPaused?(session: string): boolean;
  /** Write a row to the local chat history. Never throws. */
  record(record: ColleagueRecord): void;
  now?: () => number;
  newId?: () => string;
}

/** Input of {@link ColleagueMessageService.send}. */
export interface ColleagueSendInput {
  /** The local agent writing (from the caller's identity, never the body) */
  fromSession: string;
  /** Name or session of the colleague */
  to: string;
  text: string;
  /** Id of the colleague message this answers */
  replyTo?: string;
  /** Narrows a name two teams share */
  team?: string;
}

/** Outcome of {@link ColleagueMessageService.receive}. */
export type ColleagueReceiveOutcome =
  | { handled: true; delivered: boolean; reason?: string }
  | { handled: false; reason: string };

const MAX_TEXT = COLLEAGUE_MESSAGE_CONSTANTS.MAX_TEXT_LENGTH;

/** Sends and receives colleague messages. */
export class ColleagueMessageService {
  private readonly guard: ColleagueLoopGuard;
  private readonly seen = new Set<string>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ColleagueDeps, guard?: ColleagueLoopGuard) {
    this.guard = guard ?? new ColleagueLoopGuard({ now: deps.now });
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * The directory used for resolving: the account's when Cloud answers, else
   * the agents of this machine (so a local colleague is reachable offline).
   */
  private async directory(): Promise<{ entries: DirectoryEntry[]; cloud: boolean }> {
    const cloud = await this.deps.listDirectory().catch(() => null);
    if (cloud && cloud.length > 0) return { entries: cloud, cloud: true };
    return { entries: await this.deps.listLocalAgents().catch(() => []), cloud: false };
  }

  /**
   * Send a message to a colleague.
   *
   * @param input - Sender, target and text
   * @returns The outcome; `success: false` carries a `code` and a plain-language `error`
   */
  async send(input: ColleagueSendInput): Promise<ColleagueSendResult> {
    const text = (input.text ?? '').trim();
    if (!input.fromSession) return fail('invalid', 'Only an agent can send a colleague message.');
    if (!input.to?.trim()) return fail('invalid', 'Say who the message is for: --to <name>. `list-colleagues` shows who exists.');
    if (!text) return fail('invalid', 'The message is empty.');
    if (text.length > MAX_TEXT) return fail('invalid', `The message is ${text.length} characters; the limit is ${MAX_TEXT}. Shorten it, or put the detail in a file and say where it is.`);

    const me = await this.deps.self();
    const sender = await this.deps.describeLocal(input.fromSession);
    if (!sender) return fail('invalid', `"${input.fromSession}" is not an agent of this machine, so it cannot send a colleague message.`);

    const { entries, cloud } = await this.directory();
    const resolved = resolveColleague(entries, input.to, { fromSession: input.fromSession, team: input.team });
    if (resolved.kind === 'self') return fail('self', 'That is you. Pick a colleague other than yourself.');
    if (resolved.kind === 'ambiguous') {
      return {
        ...fail('ambiguous', `More than one colleague matches "${input.to}": ${describeCandidates(resolved.candidates)}. Repeat with --to <session> (or add --team <team>).`),
        candidates: resolved.candidates,
      };
    }
    if (resolved.kind === 'none') {
      const hint = cloud
        ? 'Run list-colleagues to see who exists.'
        : 'Crewly Cloud is not reachable, so only agents on this machine can be found. Run list-colleagues, or try again when this machine is back online.';
      const names = resolved.candidates.length > 0 ? ` Closest: ${describeCandidates(resolved.candidates)}.` : '';
      return { ...fail('not_found', `No colleague named "${input.to}" in this account.${names} ${hint}`), candidates: resolved.candidates };
    }

    const target = resolved.entry;
    const local = target.source === 'this-machine' || target.instanceId === me.instanceId;
    const wire: ColleagueWireMessage = {
      v: COLLEAGUE_MESSAGE_CONSTANTS.WIRE_VERSION,
      id: this.newId(),
      from: {
        instanceId: me.instanceId,
        deviceName: me.deviceName,
        session: input.fromSession,
        name: sender.name,
        ...(sender.team ? { team: sender.team } : {}),
      },
      toSession: target.agentSession,
      toName: target.name,
      text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      sentAt: new Date(this.now()).toISOString(),
    };

    const targetInstance = local ? me.instanceId : target.instanceId ?? '';
    const turn = this.guard.take(ColleagueLoopGuard.pairKey(`${me.instanceId}:${input.fromSession}`, `${targetInstance}:${target.agentSession}`));
    if (!turn.allowed) {
      const minutes = Math.max(1, Math.ceil(turn.retryAfterMs / 60_000));
      return fail(
        'loop_cap',
        `You and ${target.name} have exchanged ${COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_MESSAGES} messages in the last ${COLLEAGUE_MESSAGE_CONSTANTS.LOOP_CAP_WINDOW_MS / 60_000} minutes. ` +
          `Stop the back-and-forth: settle it in one message, or ask the owner. Messages to ${target.name} work again in about ${minutes} min.`,
      );
    }

    const to = { name: target.name, team: target.team, machine: target.machine, session: target.agentSession };
    const peerKey = `${targetInstance}:${target.agentSession}`;
    const peerLabel = colleagueLabel(target.name, target.team, local ? me.deviceName : target.machine);

    if (local) {
      const delivered = await this.deliver(wire);
      this.deps.record({
        agentSession: input.fromSession, peerKey, peerLabel, direction: 'out', messageId: wire.id, text,
        extra: { ...(input.replyTo ? { replyTo: input.replyTo } : {}), route: 'local', delivered: delivered.success },
      });
      // The colleague's own history (it is on this machine too).
      this.deps.record({
        agentSession: target.agentSession,
        peerKey: `${me.instanceId}:${input.fromSession}`,
        peerLabel: colleagueLabel(sender.name, sender.team, me.deviceName),
        direction: 'in', messageId: wire.id, text,
        extra: { ...(input.replyTo ? { replyTo: input.replyTo } : {}), delivered: delivered.success, ...(delivered.queued ? { queued: true } : {}) },
      });
      if (!delivered.success) return { ...fail('delivery_failed', `${target.name} did not take the message: ${delivered.error ?? 'delivery failed'}.`), messageId: wire.id, to };
      return {
        success: true, messageId: wire.id, route: 'local', to, ...(delivered.queued ? { queued: true } : {}),
        note: delivered.queued ? `${target.name} is not running: the message is queued and ${target.name} is being started.` : `Delivered to ${target.name}.`,
      };
    }

    if (!target.instanceId) return fail('machine_unknown', `The directory does not say which machine ${target.name} runs on.`);
    const outcome = await this.deps.sendRemote(target.instanceId, wire);
    this.deps.record({
      agentSession: input.fromSession, peerKey, peerLabel, direction: 'out', messageId: wire.id, text,
      extra: { ...(input.replyTo ? { replyTo: input.replyTo } : {}), route: 'remote', delivered: outcome.ok },
    });
    if (!outcome.ok) {
      return { ...fail(outcome.code, `Could not send to ${target.name} on ${target.machine ?? 'another machine'}: ${outcome.error}`), messageId: wire.id, to };
    }
    const online = this.deps.isMachineOnline?.(target.instanceId);
    return {
      success: true, messageId: wire.id, route: 'remote', to,
      note:
        online === false
          ? `${target.machine ?? 'That machine'} looks offline. The message is held by Crewly Cloud and ${target.name} gets it when the machine is back.`
          : `Sent to ${target.name} on ${target.machine ?? 'another machine'}. ${target.name}'s answer arrives as a message from your colleague.`,
    };
  }

  /**
   * Handle a `colleague_message` that arrived over the relay.
   *
   * @param payload - The relay payload (`data`)
   * @returns What happened; `handled: false` = not a valid colleague message
   */
  async receive(payload: unknown): Promise<ColleagueReceiveOutcome> {
    if (!isColleagueWireMessage(payload)) return { handled: false, reason: 'malformed' };
    const wire = payload;
    // Only a machine of this account may speak to our agents. The relay already
    // keeps other accounts out of our queue; this keeps a forged sender claim out.
    if (!this.deps.isAccountMachine(wire.from.instanceId)) return { handled: false, reason: 'unknown_machine' };
    if (this.seen.has(wire.id)) return { handled: true, delivered: false, reason: 'duplicate' };
    this.seen.add(wire.id);
    if (this.seen.size > COLLEAGUE_MESSAGE_CONSTANTS.DEDUP_MAX_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    const me = await this.deps.self();
    if (wire.from.instanceId === me.instanceId) return { handled: true, delivered: false, reason: 'own_message' };
    const text = wire.text.slice(0, MAX_TEXT);
    const target = await this.deps.describeLocal(wire.toSession);
    if (!target) return { handled: true, delivered: false, reason: 'no_such_agent' };

    const peerKey = `${wire.from.instanceId}:${wire.from.session}`;
    const peerLabel = colleagueLabel(wire.from.name, wire.from.team, wire.from.deviceName);
    const record = (extra: Record<string, unknown>): void =>
      this.deps.record({
        agentSession: wire.toSession, peerKey, peerLabel, direction: 'in', messageId: wire.id, text,
        extra: { ...(wire.replyTo ? { replyTo: wire.replyTo } : {}), ...extra },
      });

    const turn = this.guard.take(ColleagueLoopGuard.pairKey(`${me.instanceId}:${wire.toSession}`, peerKey));
    if (!turn.allowed) {
      record({ delivered: false, dropped: 'loop_cap' });
      return { handled: true, delivered: false, reason: 'loop_cap' };
    }
    if (this.deps.isPaused?.(wire.toSession)) {
      record({ delivered: false, dropped: 'team_paused' });
      return { handled: true, delivered: false, reason: 'team_paused' };
    }

    const delivered = await this.deliver({ ...wire, text });
    record({ delivered: delivered.success, ...(delivered.queued ? { queued: true } : {}) });
    return { handled: true, delivered: delivered.success, ...(delivered.success ? {} : { reason: delivered.error ?? 'delivery_failed' }) };
  }

  /** Frame a wire message and hand it to the local target. */
  private async deliver(wire: ColleagueWireMessage): Promise<{ success: boolean; queued?: boolean; error?: string }> {
    const framed = formatColleagueMessage(wire.from, wire.id, wire.text);
    try {
      return await this.deps.deliverLocal(wire.toSession, framed);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function fail(code: NonNullable<ColleagueSendResult['code']>, error: string): ColleagueSendResult {
  return { success: false, code, error };
}
