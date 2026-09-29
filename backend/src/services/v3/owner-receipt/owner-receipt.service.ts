/**
 * Owner receipt (#828) — delivery: settings, the nightly send, the API view.
 *
 * Wires the data layer ({@link buildReceiptData}) to the renderer
 * ({@link renderReceiptSlack}) and to one sender (a Slack DM to the owner).
 * Owns the owner's settings (on/off, local time, time zone) and the
 * last-sent time, which is where the next receipt's window starts.
 *
 * The rendered text goes through the secret redaction a second time before it
 * is sent: the data layer already redacts each field, and a link or a file
 * name must not be the one place a token slips through.
 *
 * @module services/v3/owner-receipt/owner-receipt.service
 */

import * as path from 'path';
import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import type { Request } from '../../../types/v2/request.types.js';
import type { WorkItem } from '../../../types/v2/work-item.types.js';
import { safeReadJson, modifyJsonFile } from '../../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../../core/logger.service.js';
import { getCrewlyHomePath } from '../../core/crewly-home.utils.js';
import { redactSensitive } from '../../wiki/wiki-redaction.js';
import { buildReceiptData, isReceiptEmpty, localDate, localParts, resolveReceiptWindow, type ReceiptCostSource } from './owner-receipt-data.js';
import { renderReceiptSlack } from './owner-receipt.renderer.js';
import type { IntakeLogReading } from '../ticket-intake-log.js';
import {
  applySettingsPatch,
  defaultReceiptSettings,
  type OwnerReceiptSettings,
  type OwnerReceiptState,
  type ReceiptData,
} from './owner-receipt.types.js';

/** Sends the rendered receipt to the owner; true when it was accepted. */
export type ReceiptSender = (text: string) => Promise<boolean>;

/** Constructor dependencies. */
export interface OwnerReceiptServiceDeps {
  listRequests: () => Promise<Request[]>;
  listWorkItems: () => Promise<WorkItem[]>;
  /** session → team name (built once per receipt) */
  loadTeamIndex: () => Promise<Map<string, string>>;
  /** team name → lead's display name (built once per receipt); absent → no lead shown */
  loadTeamLeadIndex?: () => Promise<Map<string, string>>;
  /** session → agent display name (built once per receipt); absent → decisions name the team */
  loadAgentNameIndex?: () => Promise<Map<string, string>>;
  /** Slack DM to the owner; null = cannot send (the API still works) */
  sender?: ReceiptSender | null;
  /** State file (default ~/.crewly/owner-receipt.json); null = in memory (tests) */
  statePath?: string | null;
  cost?: ReceiptCostSource;
  /** The intake outcome log (#828 coverage); absent = coverage 不详 */
  readIntakeLog?: () => Promise<IntakeLogReading>;
  now?: () => Date;
}

/** Options for {@link OwnerReceiptService.generate}. */
export interface GenerateOptions {
  /** Explicit window start (ISO) */
  from?: string;
  /** Explicit window end (ISO) */
  to?: string;
  /** `since_last_receipt` (default) or `local_day` */
  mode?: 'since_last_receipt' | 'local_day';
}

/**
 * What {@link OwnerReceiptService.send} did. `nothing_to_say`: nothing
 * notable was done and nothing waits on the owner, so no receipt went out
 * (2026-09-28) — the window still moves, as after a send.
 */
export type SendResult =
  | { sent: true; text: string; data: ReceiptData }
  | { sent: false; reason: 'no_sender' | 'sender_failed' | 'nothing_to_say'; text: string; data: ReceiptData };

/** Nightly owner receipt. */
export class OwnerReceiptService {
  private readonly logger: ComponentLogger;
  private memoryState: OwnerReceiptState = { settings: defaultReceiptSettings() };
  private readonly statePath: string | null;
  /** One send at a time (a tick and a manual send must not both go out). */
  private sending: Promise<unknown> = Promise.resolve();

  /**
   * @param deps - Data sources, sender, state file
   */
  constructor(private readonly deps: OwnerReceiptServiceDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('OwnerReceipt');
    this.statePath =
      deps.statePath === undefined ? path.join(getCrewlyHomePath(), OWNER_RECEIPT_CONSTANTS.STATE_FILENAME) : deps.statePath;
  }

  /**
   * Current state (settings + last send), defaults filled in.
   *
   * @returns State
   */
  async getState(): Promise<OwnerReceiptState> {
    const raw = this.statePath ? await safeReadJson<OwnerReceiptState | null>(this.statePath, null) : this.memoryState;
    const settings = applySettingsPatch(defaultReceiptSettings(), raw?.settings ?? {});
    return { ...(raw ?? {}), settings: settings.ok ? settings.settings : defaultReceiptSettings() };
  }

  /**
   * Change the owner's settings (time, zone, on/off).
   *
   * @param patch - Fields to change
   * @returns New settings, or the validation error
   */
  async updateSettings(patch: unknown): Promise<{ ok: true; settings: OwnerReceiptSettings } | { ok: false; error: string }> {
    const current = await this.getState();
    const result = applySettingsPatch(current.settings, patch);
    if (!result.ok) return result;
    await this.writeState({ ...current, settings: result.settings });
    this.logger.info('Owner receipt settings changed', { ...result.settings });
    return result;
  }

  /**
   * Build the receipt for a window (default: since the last receipt).
   *
   * @param opts - Window options
   * @returns The data and its rendered, redacted text
   */
  async generate(opts: GenerateOptions = {}): Promise<{ data: ReceiptData; text: string }> {
    const now = this.now();
    const state = await this.getState();
    const window = resolveReceiptWindow({
      now,
      timezone: state.settings.timezone,
      ...(state.lastSentAt ? { lastSentAt: state.lastSentAt } : {}),
      ...opts,
    });
    const [requests, workItems, teams, teamLeads, intakeLog, agentNames] = await Promise.all([
      this.deps.listRequests(),
      this.deps.listWorkItems(),
      this.deps.loadTeamIndex(),
      this.deps.loadTeamLeadIndex ? this.deps.loadTeamLeadIndex() : Promise.resolve(null),
      this.deps.readIntakeLog ? this.deps.readIntakeLog().catch(() => null) : Promise.resolve(null),
      this.deps.loadAgentNameIndex ? this.deps.loadAgentNameIndex().catch(() => null) : Promise.resolve(null),
    ]);
    const data = buildReceiptData({
      requests,
      workItems,
      window,
      teamOf: (session) => teams.get(session) ?? null,
      ...(teamLeads ? { teamLeadOf: (team: string) => teamLeads.get(team) ?? null } : {}),
      ...(agentNames ? { agentNameOf: (session: string) => agentNames.get(session) ?? null } : {}),
      intakeLog,
      ...(this.deps.cost ? { cost: this.deps.cost } : {}),
      now,
    });
    return { data, text: redactSensitive(renderReceiptSlack(data)) };
  }

  /**
   * Send the receipt now (manual send, or the scheduler) and move the window.
   * The window only moves when the send succeeded, so a failed night's asks
   * are in the next receipt.
   *
   * @returns What happened
   */
  send(): Promise<SendResult> {
    const run = this.sending.then(() => this.sendNow());
    this.sending = run.catch(() => undefined);
    return run;
  }

  /**
   * Scheduler hook: send when it is time and today's receipt has not gone out.
   *
   * @returns The send result, or null when it was not time
   */
  tick(): Promise<SendResult | null> {
    // The due check runs inside the same queue as sends: checked outside it, a
    // tick racing a manual send saw "not sent today" and DMed the owner twice.
    const run = this.sending.then(async () => ((await this.isDue()) ? this.sendNow() : null));
    this.sending = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether the nightly receipt is due: on, past the local send time, and
   * not yet sent this local day.
   *
   * @returns True when it should go out now
   */
  private async isDue(): Promise<boolean> {
    const now = this.now();
    const { settings, lastSentLocalDate } = await this.getState();
    if (!settings.enabled) return false;
    if (lastSentLocalDate === localDate(now, settings.timezone)) return false;
    const p = localParts(now, settings.timezone);
    const [h, m] = settings.time.split(':').map(Number);
    return p.hour * 60 + p.minute >= h * 60 + m;
  }

  /**
   * The send itself (serialised by {@link send}).
   *
   * @returns What happened
   */
  private async sendNow(): Promise<SendResult> {
    const { data, text } = await this.generate();
    if (isReceiptEmpty(data) || !text) {
      // Nothing done worth telling, nothing waiting on him: no message at all.
      await this.markSent(data);
      this.logger.info('Owner receipt skipped (nothing to say)', { from: data.window.from, to: data.window.to });
      return { sent: false, reason: 'nothing_to_say', text, data };
    }
    if (!this.deps.sender) return { sent: false, reason: 'no_sender', text, data };
    let ok = false;
    try {
      ok = await this.deps.sender(text);
    } catch (err) {
      this.logger.warn('Owner receipt could not be sent', { error: err instanceof Error ? err.message : String(err) });
    }
    if (!ok) return { sent: false, reason: 'sender_failed', text, data };
    await this.markSent(data);
    this.logger.info('Owner receipt sent', {
      highlights: data.highlights.length,
      decisions: data.decisionsTotal,
      from: data.window.from,
      to: data.window.to,
    });
    return { sent: true, text, data };
  }

  /**
   * Move the window: the next receipt starts where this one ended, and today
   * counts as done.
   *
   * @param data - The receipt that went out (or was skipped)
   */
  private async markSent(data: ReceiptData): Promise<void> {
    const state = await this.getState();
    await this.writeState({
      ...state,
      lastSentAt: data.window.to,
      lastSentLocalDate: localDate(new Date(data.window.to), state.settings.timezone),
    });
  }

  /**
   * Persist state.
   *
   * @param state - New state
   */
  private async writeState(state: OwnerReceiptState): Promise<void> {
    if (!this.statePath) {
      this.memoryState = state;
      return;
    }
    await modifyJsonFile<OwnerReceiptState | null, OwnerReceiptState>(this.statePath, null, () => state);
  }

  /**
   * Current time (injectable for tests).
   *
   * @returns Now
   */
  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: OwnerReceiptService | null = null;

/**
 * Install the process-wide receipt service (composition root).
 *
 * @param service - The service, or null to clear (tests)
 */
export function setOwnerReceiptService(service: OwnerReceiptService | null): void {
  instance = service;
}

/**
 * The process-wide receipt service, or null before boot wired it.
 *
 * @returns The service or null
 */
export function getOwnerReceiptService(): OwnerReceiptService | null {
  return instance;
}
