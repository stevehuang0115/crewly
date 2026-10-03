/**
 * Owner receipt — the one-time format ask (#856 follow-up, specs/owner-receipt.md).
 *
 * The calm receipt (#870) replaced the per-ask format the owner approved on
 * 9/28, but the nightly send has been off since that day, so he has never
 * seen it. Instead of turning it on for him, Crewly shows him one real sample
 * on a decision card in his DM and lets him choose:
 *
 * - **Turn on nightly — this format** → the receipt is enabled;
 * - **Keep per-ask format** → it stays off, and `per_ask` is recorded (the
 *   per-ask receipt, with its summary step, is then the work of #856);
 * - no answer by the deadline → it stays off (`no_answer`). Not asked again.
 *
 * Asked once, at the receipt's local send time, only while the receipt is off
 * and there is something to show. A withdrawn or expired card may be asked
 * again; an answered one never is.
 *
 * @module services/v3/owner-receipt/owner-receipt-format-ask
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import type { OwnerDecision } from '../../../types/decision.types.js';
import type { ComponentLogger } from '../../core/logger.service.js';
import type { DecisionKindHandler, SystemAskInput } from '../../decisions/decision.service.js';
import { PENDING_DECISION_STATUSES } from '../../decisions/decision-store.js';
import { localDate, localParts } from './owner-receipt-data.js';
import type { OwnerReceiptService } from './owner-receipt.service.js';
import type { ReceiptFormatAnswer } from './owner-receipt.types.js';

const F = OWNER_RECEIPT_CONSTANTS.FORMAT_ASK;
/** Button labels: an option reads "Label — detail" and the card's button shows the label. */
const ON_LABEL = F.OPTION_ON.split(' — ')[0];
const PER_ASK_LABEL = F.OPTION_PER_ASK.split(' — ')[0];

/** The decision service slice used here. */
export interface FormatAskDecisions {
  askSystem(input: SystemAskInput): Promise<OwnerDecision>;
  get(id: string): Promise<OwnerDecision | null>;
}

/** Collaborators. */
export interface OwnerReceiptFormatAskDeps {
  receipt: Pick<OwnerReceiptService, 'getState' | 'generate' | 'updateSettings' | 'updateFormatAsk'>;
  /** The running decision service (null before it starts) */
  decisions: () => FormatAskDecisions | null;
  logger: ComponentLogger;
  now?: () => Date;
}

/**
 * The card's body: the sample, quoted, and what each answer does.
 *
 * @param sample - Rendered receipt text (Slack mrkdwn)
 * @returns Body sections
 */
export function formatAskBody(sample: string): string[] {
  const quoted = sample
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return [
    quoted,
    `*${ON_LABEL}* sends this every night at the receipt time. ` +
      `*${PER_ASK_LABEL}* leaves it off; the receipt you approved on 9/28 (every ask on its own line, with its outcome) gets built instead. ` +
      'Nothing is turned on unless you choose it.',
  ];
}

/**
 * Asks the owner once which nightly receipt he wants, with a real sample.
 */
export class OwnerReceiptFormatAsk implements DecisionKindHandler {
  /** Local date on which there was nothing to show (don't rebuild the sample every minute) */
  private emptyOn: string | null = null;
  private asking = false;

  /**
   * @param deps - Receipt service, decisions, logger
   */
  constructor(private readonly deps: OwnerReceiptFormatAskDeps) {}

  /**
   * Scheduler hook (every minute): ask when it is time and it was not asked.
   *
   * @returns The new decision id, or null when nothing was asked
   */
  async tick(): Promise<string | null> {
    if (this.asking) return null;
    this.asking = true;
    try {
      return await this.maybeAsk();
    } finally {
      this.asking = false;
    }
  }

  /**
   * `DecisionService` kind handler: apply the answer. No agent asked, so
   * there is no note for one.
   *
   * @param d - Settled decision
   * @returns null
   */
  async onSettled(d: OwnerDecision): Promise<null> {
    await this.handleSettled(d);
    return null;
  }

  /**
   * Apply a settled format decision (also used to catch up on one settled
   * while the handler was not listening).
   *
   * @param d - Settled decision
   */
  async handleSettled(d: OwnerDecision): Promise<void> {
    if (d.kind !== F.DECISION_KIND) return;
    const state = await this.deps.receipt.getState();
    if (state.formatAsk?.decisionId !== d.id) {
      this.deps.logger.info('Ignoring an old receipt-format decision', { decisionId: d.id });
      return;
    }
    if (state.formatAsk.answer) return;
    let answer: ReceiptFormatAnswer;
    if (d.status === 'resolved') {
      const label = d.options.find((o) => o.key === d.chosenKey)?.label ?? '';
      answer = label === ON_LABEL ? 'nightly' : 'per_ask';
    } else if (d.status === 'defaulted') {
      answer = 'no_answer';
    } else {
      // Withdrawn / expired / parked: nothing was chosen; it may be asked again.
      await this.deps.receipt.updateFormatAsk(() => undefined);
      this.deps.logger.info('Receipt-format decision closed without an answer — may ask again', { decisionId: d.id, status: d.status });
      return;
    }
    if (answer === 'nightly') {
      const result = await this.deps.receipt.updateSettings({ enabled: true });
      if (!result.ok) this.deps.logger.warn('Could not turn the nightly receipt on', { error: result.error });
    }
    const at = this.now().toISOString();
    await this.deps.receipt.updateFormatAsk((cur) => (cur ? { ...cur, answer, answeredAt: at } : cur));
    this.deps.logger.info('Owner chose the nightly receipt format', { decisionId: d.id, answer });
  }

  private async maybeAsk(): Promise<string | null> {
    const now = this.now();
    const state = await this.deps.receipt.getState();
    if (state.settings.enabled) return null;
    const decisions = this.deps.decisions();
    if (!decisions) return null;
    if (state.formatAsk) {
      if (state.formatAsk.answer) return null;
      const d = await decisions.get(state.formatAsk.decisionId).catch(() => null);
      if (d && PENDING_DECISION_STATUSES.has(d.status)) return null;
      if (d) {
        // Settled while nobody listened (e.g. a restart): apply it now.
        await this.handleSettled(d);
        if ((await this.deps.receipt.getState()).formatAsk) return null;
      } else {
        await this.deps.receipt.updateFormatAsk(() => undefined);
      }
    }
    const { time, timezone } = state.settings;
    const today = localDate(now, timezone);
    if (this.emptyOn === today) return null;
    const p = localParts(now, timezone);
    const [h, m] = time.split(':').map(Number);
    if (p.hour * 60 + p.minute < h * 60 + m) return null;

    const { text } = await this.deps.receipt.generate({
      from: new Date(now.getTime() - F.SAMPLE_WINDOW_MS).toISOString(),
      to: now.toISOString(),
    });
    if (!text) {
      // Nothing done, nothing waiting: a blank sample shows nothing. Try tomorrow.
      this.emptyOn = today;
      return null;
    }
    const d = await decisions.askSystem({
      kind: F.DECISION_KIND,
      system: { key: F.SYSTEM_KEY, defaultIsDecline: true },
      title: F.TITLE,
      question: F.QUESTION,
      body: formatAskBody(text),
      options: [F.OPTION_ON, F.OPTION_PER_ASK],
      default: PER_ASK_LABEL,
      deadline: new Date(now.getTime() + F.DEADLINE_MS),
    });
    await this.deps.receipt.updateFormatAsk(() => ({ decisionId: d.id, askedAt: now.toISOString() }));
    this.deps.logger.info('Asked the owner about the nightly receipt format', { decisionId: d.id, posted: !!d.card });
    return d.id;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}
