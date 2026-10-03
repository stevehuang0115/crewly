/**
 * Daily signal digest (#987, specs/2026-10-03-signal-digest.md).
 *
 * A team lead proposes 3–5 actions for a site (the `signal-digest` skill
 * collects the signals and drafts them). This service:
 * 1. refuses actions the site's history blocks (tried with Do, or skipped
 *    recently), and replaces the site's earlier unanswered actions;
 * 2. posts ONE Slack card with Do / Skip per action, from the lead's bot, in
 *    the lead's team channel (else the owner's DM);
 * 3. on Do, opens an experiment ticket in the site's project and tells the
 *    lead; on Skip, records it so the action stays off the list for a while;
 * 4. keeps each site's signal-source status and tells the owner once when a
 *    source starts or stops failing (nothing on the days it does not change).
 *
 * @module services/signal-digest/signal-digest.service
 */

import { SIGNAL_DIGEST_CONSTANTS } from '../../constants.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { DecisionPostIdentity, DecisionSlackApi, BlockActionsPayload } from '../decisions/decision.service.js';
import type {
  CreateSignalDigestInput,
  SignalActionInput,
  SignalChoice,
  SignalDigest,
  SignalDigestItem,
  SignalHistoryEntry,
  SignalSourceReport,
  SignalSourceStatus,
} from '../../types/signal-digest.types.js';
import { SignalDigestError, blockedLines, normalizeKey, parseSourceStatuses, siteHistory, validateSignalDigest, validateSite } from './signal-digest-contract.js';
import { digestFallbackText, parseSignalButtonValue, renderDigestCard } from './signal-digest-card.js';
import type { SignalDigestStore } from './signal-digest-store.js';

/** A ticket a Do asks for. */
export interface SignalTicketInput {
  /** Project reference (name, id or path) */
  project: string;
  /** The lead's team, when known (dropped when it is not on the project) */
  team?: string;
  title: string;
  description: string;
  acceptance: string[];
  labels: string[];
  source: string;
}

/** The experiment card a Do asks for (#986): the experiment service's create input. */
export interface SignalExperimentInput {
  title: string;
  hypothesis: string;
  metric: Record<string, string>;
  ticket: { kind: 'project'; project: string; id: string };
}

/** Collaborators. */
export interface SignalDigestServiceDeps {
  store: SignalDigestStore;
  slack: () => DecisionSlackApi | null;
  instanceId: () => string;
  /** Whether a Slack user may answer (the owner) */
  isOwner: (userId: string) => boolean;
  identityOf: (session: string) => Promise<DecisionPostIdentity>;
  teamOf: (session: string) => Promise<string | undefined>;
  teamChannelOf: (teamId: string) => Promise<string | null>;
  /** The owner's DM, opened with that identity (fallback place) */
  ownerDmOf?: (identity: DecisionPostIdentity) => Promise<string | null>;
  displayName?: (session: string) => Promise<string | undefined>;
  /** Open a ticket; returns its id */
  createTicket: (input: SignalTicketInput) => Promise<{ id: string }>;
  /** Create an experiment card as that session (#986); absent = experiment cards are off */
  createExperiment?: (input: SignalExperimentInput, caller: string) => Promise<{ id: string }>;
  /** Tell an agent something (wakes it when needed) */
  deliverToAgent: (session: string, text: string) => Promise<boolean>;
  /** Tell the owner (false = not delivered); absent = no source-change notices */
  notifyOwner?: (notice: { title: string; message: string; urgent: boolean }) => Promise<boolean>;
  logger: ComponentLogger;
  now?: () => Date;
}

/** What a Slack click did. */
export interface SignalInteractionOutcome {
  handled: boolean;
  reason: string;
  digest?: SignalDigest;
}

/**
 * Error text.
 *
 * @param err - Anything thrown
 * @returns Message
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The description of the ticket a Do opens: the digest item plus the
 * experiment card fields #986 measures (hypothesis, metric, baseline, window).
 *
 * @param digest - Digest
 * @param item - The action
 * @returns Markdown
 */
export function experimentTicketDescription(digest: SignalDigest, item: SignalDigestItem): string {
  return [
    `From the daily signal digest ${digest.id} for ${digest.site} (${digest.createdAt.slice(0, 10)}), action ${item.n}. The owner chose Do.`,
    '',
    '## Signal',
    item.signal,
    '',
    '## Proposal',
    item.proposal,
    '',
    '## Expected effect',
    item.expectedEffect,
    '',
    '## Effort',
    item.effort,
    '',
    '## Experiment',
    `- Hypothesis: ${item.proposal} → ${item.expectedEffect}`,
    `- Metric: ${item.metric ?? (item.experiment ? `${item.experiment.source} ${item.experiment.measure}` : 'name the metric (GA4 / Search Console) before shipping')}`,
    item.experiment && digest.config
      ? '- Baseline and result: measured automatically by the experiment card linked to this ticket (when it is done, and after the window)'
      : '- Baseline: capture it right before the change ships (or add an experiment card)',
    `- Window: ${SIGNAL_DIGEST_CONSTANTS.EXPERIMENT_WINDOW_DAYS} days after shipping`,
    `- Signal key: \`${item.key}\` (source: ${item.source})`,
  ].join('\n');
}

/**
 * How a source is named to the owner.
 *
 * @param name - Source name
 * @returns Label
 */
export function sourceLabel(name: string): string {
  return SIGNAL_DIGEST_CONSTANTS.SOURCE_LABELS[name] ?? name;
}

/**
 * Whether a digest holds the same actions (by key) as a proposal.
 *
 * @param digest - Stored digest
 * @param items - Proposed actions
 * @returns True for the same key set
 */
function sameActions(digest: SignalDigest, items: readonly SignalActionInput[]): boolean {
  const a = digest.items.map((i) => normalizeKey(i.key)).sort();
  const b = items.map((i) => normalizeKey(i.key)).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Signal digests: proposals, the Slack card, the owner's answers.
 */
export class SignalDigestService {
  private static instance: SignalDigestService | null = null;
  private readonly now: () => Date;
  /** Source reports are handled one at a time (one change notice per change) */
  private sourceChain: Promise<unknown> = Promise.resolve();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: SignalDigestServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The running service, when started. */
  static getInstance(): SignalDigestService | null {
    return SignalDigestService.instance;
  }

  /**
   * Set (or clear) the running service.
   *
   * @param service - Service or null
   */
  static setInstance(service: SignalDigestService | null): void {
    SignalDigestService.instance = service;
  }

  /**
   * Propose a digest. The site's earlier unanswered actions are replaced
   * (expired) first; then any action the history still blocks is refused.
   *
   * @param callerSession - Team lead session (X-Agent-Session)
   * @param input - `{ site, project?, config?, items }`
   * @returns The stored digest (with `card`, or `postError` when Slack refused)
   * @throws SignalDigestError(400) for a contract violation, (409) for blocked actions
   */
  async propose(callerSession: string | undefined, input: CreateSignalDigestInput): Promise<SignalDigest> {
    if (!callerSession) throw new SignalDigestError(400, 'Who is proposing? Run signal-digest propose from the team lead\'s agent session.');
    const valid = validateSignalDigest(input);
    // One card a day: a digest from the last DUPLICATE_WINDOW_MS with actions
    // still open stands. The same actions again (a retried call) get it back;
    // different ones are refused instead of posting a second card.
    const recent = await this.recentOpenDigest(valid.site);
    if (recent) {
      if (sameActions(recent, valid.items)) {
        this.deps.logger.info('Signal digest proposed again — returning the open one', { digestId: recent.id, site: recent.site });
        return recent;
      }
      const open = recent.items.filter((i) => i.status === 'open').length;
      throw new SignalDigestError(
        409,
        `${recent.id} for ${recent.site} was posted at ${recent.createdAt} and still has ${open} open action(s) waiting for the owner. Do not post another card today; the next run replaces the unanswered actions.`,
      );
    }
    const sources = valid.sources ? (await this.recordSources(callerSession, valid.site, valid.sources)).sources : await this.latestSources(valid.site);
    const all = await this.deps.store.list();
    const history = siteHistory(all, valid.site, this.now()).filter((h) => h.status !== 'open');
    const blocked = blockedLines(valid.items, history);
    if (blocked.length > 0) {
      throw new SignalDigestError(
        409,
        `These actions were already decided for ${valid.site}; replace them with other actions and propose again:\n- ${blocked.join('\n- ')}`,
      );
    }
    await this.expireOpen(valid.site);
    await this.deps.store.prune().catch(() => 0);
    const teamId = await this.deps.teamOf(callerSession).catch(() => undefined);
    const digest = await this.deps.store.create({
      site: valid.site,
      asker: callerSession,
      ...(teamId ? { teamId } : {}),
      ...(valid.project ? { project: valid.project } : {}),
      ...(valid.config ? { config: valid.config } : {}),
      ...(sources ? { sources } : {}),
      items: valid.items.map((item, i) => ({ ...item, n: i + 1, status: 'open' as const })),
    });
    this.deps.logger.info('Signal digest proposed', { digestId: digest.id, site: digest.site, asker: callerSession, items: digest.items.length });
    return this.postCard(digest);
  }

  /**
   * A site's digest proposed within DUPLICATE_WINDOW_MS that still has open actions.
   *
   * @param site - Site
   * @returns The newest such digest, or null
   */
  private async recentOpenDigest(site: string): Promise<SignalDigest | null> {
    const want = site.trim().toLowerCase();
    const since = this.now().getTime() - SIGNAL_DIGEST_CONSTANTS.DUPLICATE_WINDOW_MS;
    const recent = await this.deps.store.list(
      (d) => d.site.trim().toLowerCase() === want && Date.parse(d.createdAt) >= since && d.items.some((i) => i.status === 'open'),
    );
    return recent[0] ?? null;
  }

  /**
   * The site's latest source report, when it is recent enough to describe today's run.
   *
   * @param site - Site
   * @returns Statuses, or undefined
   */
  private async latestSources(site: string): Promise<SignalSourceStatus[] | undefined> {
    const s = await this.deps.store.getSiteSources(site).catch(() => null);
    if (!s || this.now().getTime() - Date.parse(s.reportedAt) > SIGNAL_DIGEST_CONSTANTS.SOURCE_REPORT_MAX_AGE_MS) return undefined;
    return s.sources;
  }

  /**
   * A collect run's source statuses (`POST /api/signal-digests/sources`).
   * Stored per site; the owner is told once when a source starts or stops
   * failing — not every day it stays broken.
   *
   * @param callerSession - Team lead session (X-Agent-Session)
   * @param input - `{ site, sources }`
   * @returns What changed and whether the owner was told
   * @throws SignalDigestError(400)
   */
  async reportSources(callerSession: string | undefined, input: { site?: unknown; sources?: unknown }): Promise<SignalSourceReport> {
    if (!callerSession) throw new SignalDigestError(400, "Who is reporting? Run signal-digest collect from the team lead's agent session.");
    const site = validateSite(input.site);
    const sources = parseSourceStatuses(input.sources);
    if (!sources || sources.length === 0) throw new SignalDigestError(400, '"sources" is required: {"ga4":"ok","gsc":"error: why",…} as collect prints it.');
    return this.recordSources(callerSession, site, sources);
  }

  /**
   * Store a source report and send the change notice (see {@link reportSources}).
   *
   * @param caller - Reporting session
   * @param site - Site
   * @param sources - Statuses
   * @returns The report outcome
   */
  private recordSources(caller: string, site: string, sources: SignalSourceStatus[]): Promise<SignalSourceReport> {
    const run = async (): Promise<SignalSourceReport> => {
      const at = this.now().toISOString();
      const failing = sources.filter((s) => s.state === 'error').map((s) => s.name);
      const state = await this.deps.store.updateSiteSources(site, (cur) => ({
        site,
        sources,
        reportedAt: at,
        reportedBy: caller,
        toldFailing: cur?.toldFailing ?? [],
        ...(cur?.toldAt ? { toldAt: cur.toldAt } : {}),
      }));
      const told = new Set(state.toldFailing);
      const started = failing.filter((n) => !told.has(n));
      const stopped = state.toldFailing.filter((n) => !failing.includes(n));
      const out: SignalSourceReport = { site, sources, started, stopped, notified: false };
      if ((started.length === 0 && stopped.length === 0) || !this.deps.notifyOwner) return out;
      const lines: string[] = [];
      for (const n of started) lines.push(`Not working: ${sourceLabel(n)} — ${sources.find((s) => s.name === n)?.detail ?? 'failed'}`);
      for (const n of stopped) lines.push(`Working again: ${sourceLabel(n)}`);
      if (started.length > 0) lines.push('The daily digest runs without it until it is fixed. You will hear again only when this changes.');
      const sent = await this.deps
        .notifyOwner({
          title: `Signal digest · ${site}: ${started.length > 0 ? 'a signal source is failing' : 'signal sources work again'}`,
          message: lines.join('\n'),
          urgent: false,
        })
        .catch(() => false);
      if (sent) {
        await this.deps.store.updateSiteSources(site, (cur) => ({ ...(cur ?? { site, sources, reportedAt: at }), toldFailing: failing, toldAt: at }));
        out.notified = true;
      }
      this.deps.logger.info('Signal digest source status changed', { site, started, stopped, notified: out.notified });
      return out;
    };
    const next = this.sourceChain.then(run, run);
    this.sourceChain = next.catch(() => undefined);
    return next;
  }

  /**
   * The site's blocked keys (Do within 90 days, Skip within 30) and its open ones.
   *
   * @param site - Site
   * @returns History entries
   */
  async history(site: string): Promise<SignalHistoryEntry[]> {
    return siteHistory(await this.deps.store.list(), site, this.now());
  }

  /**
   * Digests, newest first.
   *
   * @param site - Only this site, when given
   * @returns Digests
   */
  async list(site?: string): Promise<SignalDigest[]> {
    const want = site?.trim().toLowerCase();
    return this.deps.store.list((d) => !want || d.site.trim().toLowerCase() === want);
  }

  /**
   * One digest.
   *
   * @param id - Digest id
   * @returns Digest or null
   */
  get(id: string): Promise<SignalDigest | null> {
    return this.deps.store.get(id);
  }

  /**
   * Answer one action from the dashboard / API (owner only; the caller checks).
   *
   * @param id - Digest id
   * @param n - Item number
   * @param choice - do / skip
   * @returns The updated digest
   * @throws SignalDigestError(404) unknown digest / item, (409) already answered
   */
  async choose(id: string, n: number, choice: SignalChoice): Promise<SignalDigest> {
    const digest = await this.deps.store.get(id);
    if (!digest) throw new SignalDigestError(404, `Signal digest ${id} not found`);
    const item = digest.items.find((i) => i.n === n);
    if (!item) throw new SignalDigestError(404, `${id} has no action ${n}`);
    if (item.status !== 'open') throw new SignalDigestError(409, `${id} action ${n} is already ${item.status}`);
    const out = await this.apply(id, n, choice, 'dashboard');
    if (!out) throw new SignalDigestError(409, `${id} action ${n} was answered meanwhile`);
    return out;
  }

  /**
   * A Slack `block_actions` payload. Ignores anything that is not a click on
   * one of this instance's digest cards by the owner.
   *
   * @param payload - Slack payload
   * @returns What happened
   */
  async handleInteraction(payload: BlockActionsPayload): Promise<SignalInteractionOutcome> {
    const action = payload?.actions?.[0];
    if (!action?.action_id?.startsWith(SIGNAL_DIGEST_CONSTANTS.ACTION_PREFIX)) return { handled: false, reason: 'not a signal digest action' };
    const value = parseSignalButtonValue(action.value);
    if (!value) return { handled: false, reason: 'unreadable button value' };
    const self = this.deps.instanceId();
    if (value.i && self && value.i !== self) return { handled: false, reason: `card belongs to instance ${value.i}` };
    const digest = await this.deps.store.get(value.s);
    if (!digest) return { handled: false, reason: `unknown digest ${value.s}` };
    const channel = payload.container?.channel_id ?? payload.channel?.id;
    const ts = payload.container?.message_ts ?? payload.message?.ts;
    if (!digest.card || digest.card.slackChannelId !== channel || digest.card.messageTs !== ts) {
      return { handled: false, reason: 'click is not on the stored card', digest };
    }
    const user = payload.user?.id ?? '';
    if (!user || !this.deps.isOwner(user)) {
      this.deps.logger.info('Signal digest click by someone other than the owner — ignored', { digestId: digest.id, user });
      return { handled: false, reason: 'not the owner', digest };
    }
    const item = digest.items.find((i) => i.n === value.n);
    if (!item) return { handled: false, reason: `no action ${value.n}`, digest };
    if (item.status !== 'open') return { handled: false, reason: `already ${item.status}`, digest };
    const out = await this.apply(digest.id, value.n, value.o, user);
    return out ? { handled: true, reason: value.o, digest: out } : { handled: false, reason: 'answered meanwhile', digest };
  }

  /**
   * Record the answer; on Do open the ticket and tell the lead; redraw the card.
   *
   * @param id - Digest id
   * @param n - Item number
   * @param choice - do / skip
   * @param by - Slack user id, or `dashboard`
   * @returns The updated digest, or null when the item was not open
   */
  private async apply(id: string, n: number, choice: SignalChoice, by: string): Promise<SignalDigest | null> {
    const at = this.now().toISOString();
    let digest = await this.deps.store.update(id, (d) => {
      const item = d.items.find((i) => i.n === n);
      if (!item || item.status !== 'open') return null;
      Object.assign(item, { status: choice, answeredAt: at, answeredBy: by });
      return d;
    });
    if (!digest) return null;
    const item = digest.items.find((i) => i.n === n) as SignalDigestItem;
    this.deps.logger.info('Signal digest answered', { digestId: id, item: n, choice, by });
    if (choice === 'do') {
      const ticket = await this.openTicket(digest, item);
      const experiment = ticket.id ? await this.openExperiment(digest, item, ticket.id) : null;
      digest = (await this.deps.store.update(id, (d) => {
        const it = d.items.find((i) => i.n === n);
        if (!it) return null;
        if (ticket.id) it.ticketId = ticket.id;
        else it.ticketError = ticket.error;
        if (experiment?.id) it.experimentId = experiment.id;
        else if (experiment?.error) it.experimentError = experiment.error;
        return d;
      })) ?? digest;
      const updated = digest.items.find((i) => i.n === n) as SignalDigestItem;
      await this.tellAsker(digest, this.doNote(digest, updated));
    }
    await this.refreshCard(digest);
    return digest;
  }

  /**
   * Open the experiment ticket of a Do.
   *
   * @param digest - Digest
   * @param item - The action
   * @returns The ticket id, or why there is none
   */
  private async openTicket(digest: SignalDigest, item: SignalDigestItem): Promise<{ id?: string; error?: string }> {
    if (!digest.project) return { error: 'no project set for this site (signalDigest.project in its config)' };
    try {
      const ticket = await this.deps.createTicket({
        project: digest.project,
        ...(digest.teamId ? { team: digest.teamId } : {}),
        title: `Experiment: ${item.proposal}`.slice(0, SIGNAL_DIGEST_CONSTANTS.TICKET_TITLE_MAX_CHARS),
        description: experimentTicketDescription(digest, item),
        acceptance: [
          'Baseline of the metric recorded right before the change ships',
          'Change shipped',
          `Result recorded after ${SIGNAL_DIGEST_CONSTANTS.EXPERIMENT_WINDOW_DAYS} days: worked / didn't / inconclusive`,
        ],
        labels: [...SIGNAL_DIGEST_CONSTANTS.TICKET_LABELS],
        source: `signal-digest:${digest.id}#${item.n}`,
      });
      return { id: ticket.id };
    } catch (err) {
      this.deps.logger.warn('Signal digest: Do ticket not created', { digestId: digest.id, item: item.n, error: errText(err) });
      return { error: errText(err).slice(0, SIGNAL_DIGEST_CONSTANTS.EXPECTED_MAX_CHARS) };
    }
  }

  /**
   * Create the experiment card of a Do (#986), linked to its ticket, as the
   * lead (its prediction is recorded under the lead). Only when the action
   * names a metric and the digest has the seo-ops config.
   *
   * @param digest - Digest
   * @param item - The action
   * @param ticketId - The ticket the Do opened
   * @returns The card id, why there is none, or null when none was asked for
   */
  private async openExperiment(digest: SignalDigest, item: SignalDigestItem, ticketId: string): Promise<{ id?: string; error?: string } | null> {
    if (!item.experiment || !digest.config || !digest.project) return null;
    if (!this.deps.createExperiment) return { error: 'experiment cards are not running on this instance' };
    try {
      const { source, measure, ...filters } = item.experiment;
      const card = await this.deps.createExperiment(
        {
          title: item.proposal.slice(0, SIGNAL_DIGEST_CONSTANTS.TICKET_TITLE_MAX_CHARS),
          hypothesis: `${item.proposal} → ${item.expectedEffect}`,
          metric: { source, measure, config: digest.config, ...filters, ...(item.metric ? { label: item.metric } : {}) },
          ticket: { kind: 'project', project: digest.project, id: ticketId },
        },
        digest.asker,
      );
      return { id: card.id };
    } catch (err) {
      this.deps.logger.warn('Signal digest: experiment card not created', { digestId: digest.id, item: item.n, error: errText(err) });
      return { error: errText(err).slice(0, SIGNAL_DIGEST_CONSTANTS.EXPECTED_MAX_CHARS) };
    }
  }

  /**
   * What the lead is told after a Do.
   *
   * @param digest - Digest
   * @param item - The answered action
   * @returns Message text
   */
  private doNote(digest: SignalDigest, item: SignalDigestItem): string {
    const head = `[SIGNAL DIGEST] The owner chose Do for ${digest.id} action ${item.n} (${digest.site}): "${item.proposal}".`;
    if (item.ticketId && item.experimentId) {
      return `${head} Ticket ${item.ticketId} is ready in ${digest.project}, with experiment card ${item.experimentId}: ship the change and close the ticket — the baseline and the result are measured automatically.`;
    }
    if (item.ticketId) {
      const why = item.experimentError ? ` The experiment card was not created (${item.experimentError}); create it with experiment-card before you ship.` : '';
      return `${head} Ticket ${item.ticketId} is ready in ${digest.project}: run it as an experiment — record the baseline of "${item.metric ?? 'the metric'}" right before you ship, then the result after ${SIGNAL_DIGEST_CONSTANTS.EXPERIMENT_WINDOW_DAYS} days.${why}`;
    }
    return `${head} No ticket was created (${item.ticketError}). Create it yourself with project-tickets, labelled ${SIGNAL_DIGEST_CONSTANTS.TICKET_LABELS.join(' + ')}, and run it as an experiment.`;
  }

  /**
   * Replace the site's earlier unanswered actions: they become `expired` and
   * their cards say so.
   *
   * @param site - Site
   */
  private async expireOpen(site: string): Promise<void> {
    const want = site.trim().toLowerCase();
    const open = await this.deps.store.list((d) => d.site.trim().toLowerCase() === want && d.items.some((i) => i.status === 'open'));
    const at = this.now().toISOString();
    for (const d of open) {
      const expired = await this.deps.store.update(d.id, (cur) => {
        for (const item of cur.items) if (item.status === 'open') Object.assign(item, { status: 'expired', answeredAt: at });
        return cur;
      });
      if (expired) await this.refreshCard(expired);
    }
  }

  /**
   * Post the card: the lead's team channel from the lead's bot, else the
   * owner's DM.
   *
   * @param digest - Digest without a card
   * @returns The digest with `card`, or `postError`
   */
  private async postCard(digest: SignalDigest): Promise<SignalDigest> {
    const slack = this.deps.slack();
    if (!slack || !slack.isConnected()) {
      return (await this.deps.store.update(digest.id, (d) => ({ ...d, postError: 'Slack is not connected' }))) ?? digest;
    }
    try {
      const identity = await this.deps.identityOf(digest.asker);
      const channel = (digest.teamId ? await this.deps.teamChannelOf(digest.teamId) : null) ?? (await this.deps.ownerDmOf?.(identity)) ?? null;
      if (!channel) throw new Error(`No Slack team channel for ${digest.asker} and no DM with the owner`);
      const askerName = await this.deps.displayName?.(digest.asker).catch(() => undefined);
      const message = { channelId: channel, text: digestFallbackText(digest), blocks: renderDigestCard(digest, this.deps.instanceId(), askerName), skipChatV2Mirror: true };
      let ts: string;
      let ownBot = false;
      if (identity.botToken) {
        try {
          ts = await slack.sendMessage({ ...message, botToken: identity.botToken });
          ownBot = true;
        } catch (err) {
          this.deps.logger.warn("Lead's own bot could not post the signal digest — using the shared bot", { digestId: digest.id, error: errText(err) });
          ts = await slack.sendMessage({ ...message, ...identity, botToken: undefined });
        }
      } else {
        ts = await slack.sendMessage({ ...message, ...identity });
      }
      const updated = await this.deps.store.update(digest.id, (d) => {
        const next: SignalDigest = { ...d, card: { slackChannelId: channel, messageTs: ts, postedBy: ownBot ? digest.asker : 'crewly', ownBot } };
        delete next.postError;
        return next;
      });
      this.deps.logger.info('Signal digest card posted', { digestId: digest.id, channel, ownBot });
      return updated ?? digest;
    } catch (err) {
      this.deps.logger.warn('Signal digest card not posted', { digestId: digest.id, error: errText(err) });
      return (await this.deps.store.update(digest.id, (d) => ({ ...d, postError: errText(err) }))) ?? digest;
    }
  }

  /**
   * Redraw a posted card.
   *
   * @param digest - Digest
   * @returns True when Slack accepted the update
   */
  private async refreshCard(digest: SignalDigest): Promise<boolean> {
    const slack = this.deps.slack();
    if (!digest.card || !slack) return false;
    try {
      const askerName = await this.deps.displayName?.(digest.asker).catch(() => undefined);
      const token = digest.card.ownBot ? (await this.deps.identityOf(digest.card.postedBy).catch(() => ({}) as DecisionPostIdentity)).botToken : undefined;
      await slack.updateMessage(digest.card.slackChannelId, digest.card.messageTs, digestFallbackText(digest), renderDigestCard(digest, this.deps.instanceId(), askerName), token);
      return true;
    } catch (err) {
      this.deps.logger.warn('Could not update the signal digest card', { digestId: digest.id, error: errText(err) });
      return false;
    }
  }

  /**
   * Tell the lead (best effort).
   *
   * @param digest - Digest
   * @param text - Message
   */
  private async tellAsker(digest: SignalDigest, text: string): Promise<void> {
    try {
      await this.deps.deliverToAgent(digest.asker, text);
    } catch (err) {
      this.deps.logger.warn('Could not tell the lead about the signal digest answer', { digestId: digest.id, error: errText(err) });
    }
  }
}
