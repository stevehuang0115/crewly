/**
 * Tests for runtime Terms consent, end to end over the real decision-card
 * service (mocked Slack Web API, injected clock) and the fake agy TUI:
 * detection → one card in the owner's orc-bot DM; each button drives the
 * TUI to the right checkbox state; a mismatch never presses Done; the
 * deadline applies Don't agree; English text only.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DecisionService, type BlockActionsPayload, type DecisionServiceDeps, type DecisionSlackApi } from '../decisions/decision.service.js';
import { DecisionStore } from '../decisions/decision-store.js';
import { TicketThreadStore } from '../decisions/ticket-thread-store.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { SlackBlock, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { SmokeTestResult } from '../runtime-fallback/runtime-smoke-test.service.js';
import { driveAntigravityTerms } from './antigravity-terms-driver.js';
import { FakeAgyTui, type FakeAgyOptions } from './fake-agy-tui.fixture.js';
import { RuntimeTermsConsentService, choiceOfLabel, screenForThread, type RuntimeTermsProfile } from './runtime-terms-consent.service.js';
import { RuntimeTermsStore } from './runtime-terms.store.js';
import { ANTIGRAVITY_TERMS_PROFILE, antigravityTermsCard } from './runtime-terms.wiring.js';

const quiet = (): ComponentLogger => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;
const OWNER = 'U-OWNER';
const DM = 'D-ORC-DM';
const AGY = 'antigravity-cli';
const HOUR = 60 * 60 * 1000;
/** Any CJK character: harness text must be English. */
const CJK = /[　-〿㐀-鿿＀-￯]/;

class FakeSlack implements DecisionSlackApi {
	sent: SlackOutgoingMessage[] = [];
	updates: Array<{ channelId: string; ts: string; text: string; blocks?: SlackBlock[] }> = [];
	private n = 0;
	isConnected(): boolean {
		return true;
	}
	async sendMessage(m: SlackOutgoingMessage): Promise<string> {
		this.sent.push(m);
		this.n += 1;
		return `200.${String(this.n).padStart(4, '0')}`;
	}
	async updateMessage(channelId: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void> {
		this.updates.push({ channelId, ts, text, blocks });
	}
}

interface Harness {
	terms: RuntimeTermsConsentService;
	decisions: DecisionService;
	slack: FakeSlack;
	store: RuntimeTermsStore;
	clock: { now: Date };
	tuis: FakeAgyTui[];
	closed: string[];
	smoke: jest.Mock;
	delivered: string[];
	tuiOpts: FakeAgyOptions;
}

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-terms-'));
});
afterEach(async () => {
	DecisionService.registerKindHandler('runtime_terms', null);
	await fs.rm(dir, { recursive: true, force: true });
});

function harness(tuiOpts: FakeAgyOptions = {}, home = dir): Harness {
	const clock = { now: new Date(2026, 9, 1, 10, 0, 0) };
	const slack = new FakeSlack();
	const delivered: string[] = [];
	const deps: DecisionServiceDeps = {
		store: new DecisionStore(path.join(home, 'decisions.json'), () => clock.now),
		threads: TicketThreadStore.inHome(home),
		slack: () => slack,
		instanceId: () => 'inst-1',
		isOwner: (u) => u === OWNER,
		ownerUserId: () => OWNER,
		identityOf: async (session) => (session === 'crewly-orc' ? { botToken: 'xoxb-orc' } : {}),
		teamChannelOf: async () => null,
		teamOf: async () => undefined,
		resolveTicket: async () => {
			throw new Error('no tickets here');
		},
		markTicketAsked: jest.fn(),
		logTicket: jest.fn(),
		deliverToAgent: async (session, text) => {
			delivered.push(`${session}: ${text}`);
			return true;
		},
		ownerDmOf: async (identity) => (identity.botToken === 'xoxb-orc' ? DM : null),
		now: () => clock.now,
		logger: quiet(),
	};
	const decisions = new DecisionService(deps);
	const store = RuntimeTermsStore.inHome(home);
	const tuis: FakeAgyTui[] = [];
	const closed: string[] = [];
	const smoke = jest.fn(async (runtime: string): Promise<SmokeTestResult> => ({ runtime, passed: true, steps: [], durationMs: 42_000 }));
	const h: Harness = { terms: null as unknown as RuntimeTermsConsentService, decisions, slack, store, clock, tuis, closed, smoke, delivered, tuiOpts };
	let t = 0;
	const profile: RuntimeTermsProfile = {
		runtime: AGY,
		label: 'Antigravity CLI',
		info: { summary: 'Terms', dataItem: 'Data', links: [] },
		card: antigravityTermsCard,
		classify: ANTIGRAVITY_TERMS_PROFILE.classify,
		drive: (term, shareData) => driveAntigravityTerms(term, { shareData, now: () => t, sleep: async (ms) => void (t += ms) }),
	};
	h.terms = new RuntimeTermsConsentService({
		store,
		decisions: () => decisions,
		profiles: { [AGY]: profile },
		launch: async () => {
			const tui = new FakeAgyTui(h.tuiOpts);
			tuis.push(tui);
			return { terminal: tui, close: async () => void closed.push('dedicated') };
		},
		closeSession: async (runtime) => void closed.push(`kill:${runtime}`),
		runSmokeTest: smoke,
		machineName: () => 'steve-mbp',
		now: () => clock.now,
		sleep: async () => undefined,
		probeTimeoutMs: 1_000,
		logger: quiet(),
	});
	DecisionService.registerKindHandler('runtime_terms', h.terms);
	return h;
}

/** Click a card button as the owner. */
async function click(h: Harness, label: string): Promise<void> {
	const rec = h.store.get(AGY);
	const d = await h.decisions.get(rec?.decisionId ?? '');
	if (!d?.card) throw new Error('no card');
	const opt = d.options.find((o) => o.label === label);
	const payload: BlockActionsPayload = {
		type: 'block_actions',
		user: { id: OWNER },
		actions: [{ action_id: `decision:${opt?.key}`, value: JSON.stringify({ d: d.id, o: opt?.key, i: 'inst-1' }) }],
		container: { channel_id: d.card.slackChannelId, message_ts: d.card.messageTs },
	};
	const out = await h.decisions.handleInteraction(payload);
	expect(out.handled).toBe(true);
	await h.terms.whenIdle(AGY);
}

/** Thread replies posted under the card. */
function threadTexts(h: Harness): string[] {
	return h.slack.sent.filter((m) => m.threadTs).map((m) => m.text);
}

describe('RuntimeTermsConsentService', () => {
	it('detection → ONE card in the owner DM from the orc bot, with the three choices', async () => {
		const h = harness();
		await Promise.all([
			h.terms.reportTermsScreen(AGY, { source: 'launch' }),
			h.terms.reportTermsScreen(AGY, { source: 'smoke_test' }),
		]);
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });

		const cards = h.slack.sent.filter((m) => m.blocks);
		expect(cards).toHaveLength(1);
		const card = cards[0];
		expect(card.channelId).toBe(DM);
		expect(card.botToken).toBe('xoxb-orc');
		const json = JSON.stringify(card.blocks);
		expect(json).toContain('Antigravity CLI · Terms of Service (steve-mbp)');
		expect(json).toContain('https://antigravity.google/terms');
		expect(json).toContain('https://policies.google.com/privacy');
		expect(json).toContain('A separate item, pre-checked on the screen');
		expect(json).not.toContain('Remind me tomorrow');
		const actions = (card.blocks as unknown as Array<{ type: string; elements?: Array<{ text: { text: string } }> }>).find((b) => b.type === 'actions');
		expect(actions?.elements?.map((e) => e.text.text)).toEqual(['Agree, no data sharing', 'Agree + share data', "Don't agree"]);
		expect(json).toContain("No answer by tomorrow 10:00: Don't agree.");

		const rec = h.store.get(AGY);
		expect(rec).toMatchObject({ status: 'pending', detectedBy: 'launch' });
		const d = await h.decisions.get(rec?.decisionId ?? '');
		expect(d).toMatchObject({ sensitive: 'runtime_terms', kind: 'runtime_terms', system: { key: AGY, defaultIsDecline: true }, asker: 'crewly-orc' });
		expect(Date.parse(d?.deadline ?? '') - h.clock.now.getTime()).toBe(24 * HOUR);
		expect(h.terms.blockedReason(AGY)).toMatch(/Waiting for you to accept/);
		expect(h.tuis).toHaveLength(0);
	});

	it('"Agree, no data sharing" drives the TUI with the box unchecked, then runs the smoke test', async () => {
		const h = harness();
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		await click(h, 'Agree, no data sharing');

		expect(h.tuis).toHaveLength(1);
		expect(h.tuis[0].accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: false });
		expect(h.tuis[0].doneCount).toBe(1);
		expect(h.closed).toEqual(['dedicated']);
		expect(h.smoke).toHaveBeenCalledWith(AGY);
		expect(h.store.get(AGY)).toMatchObject({ status: 'accepted', dataSharing: false });
		expect(h.terms.blockedReason(AGY)).toBeNull();
		const replies = threadTexts(h);
		expect(replies[0]).toMatch(/Accepted on steve-mbp: Antigravity CLI's Terms, data sharing off/);
		expect(replies[1]).toMatch(/Runtime test passed in 42s/);
		// The harness's own decision never wakes an agent.
		expect(h.delivered).toEqual([]);
	});

	it('"Agree + share data" leaves the pre-checked box checked', async () => {
		const h = harness({ migration: true });
		await h.terms.reportTermsScreen(AGY, { source: 'smoke_test' });
		await click(h, 'Agree + share data');
		expect(h.tuis[0].accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: true });
		expect(h.store.get(AGY)).toMatchObject({ status: 'accepted', dataSharing: true });
		expect(threadTexts(h)[0]).toMatch(/data sharing on/);
	});

	it('"Don\'t agree" never launches the TUI, closes the session and marks the runtime skipped', async () => {
		const h = harness();
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		await click(h, "Don't agree");
		expect(h.tuis).toHaveLength(0);
		expect(h.closed).toEqual([`kill:${AGY}`]);
		expect(h.smoke).not.toHaveBeenCalled();
		expect(h.store.get(AGY)).toMatchObject({ status: 'declined', reason: "You chose Don't agree" });
		expect(h.terms.blockedReason(AGY)).toBe("Terms not accepted: You chose Don't agree");
		expect(threadTexts(h)[0]).toMatch(/OK, not accepted\. Antigravity CLI is marked "terms not accepted" on steve-mbp/);

		// Not asked again on launch …
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		expect(h.slack.sent.filter((m) => m.blocks)).toHaveLength(1);
		// … only when the owner presses Test / re-adds it / Accept terms….
		await h.terms.reportTermsScreen(AGY, { source: 'smoke_test', ownerInitiated: true });
		expect(h.slack.sent.filter((m) => m.blocks)).toHaveLength(2);
		expect(h.store.get(AGY)?.status).toBe('pending');
	});

	it('a screen mismatch aborts without Done and shows the screen in the thread', async () => {
		const h = harness({ changedTerms: true });
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		await click(h, 'Agree, no data sharing');
		expect(h.tuis[0].doneCount).toBe(0);
		expect(h.tuis[0].accepted).toBeNull();
		expect(h.smoke).not.toHaveBeenCalled();
		expect(h.store.get(AGY)).toMatchObject({ status: 'failed' });
		const reply = threadTexts(h)[0];
		expect(reply).toMatch(/nothing was accepted \(Done was not pressed\)/);
		expect(reply).toContain('```');
		expect(reply).toContain('Terms of Service & Data Use');
		expect(h.terms.blockedReason(AGY)).toMatch(/^Terms not accepted: the setup stopped/);
	});

	it('the deadline applies Don\'t agree (sensitive, but declining is the safe default)', async () => {
		const h = harness();
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		h.clock.now = new Date(h.clock.now.getTime() + 23 * HOUR);
		expect(await h.decisions.tick()).toEqual([]);
		h.clock.now = new Date(h.clock.now.getTime() + 2 * HOUR);
		expect(await h.decisions.tick()).toHaveLength(1);
		await h.terms.whenIdle(AGY);
		const d = await h.decisions.get(h.store.get(AGY)?.decisionId ?? '');
		expect(d).toMatchObject({ status: 'defaulted', answeredVia: 'deadline' });
		expect(h.tuis).toHaveLength(0);
		expect(h.store.get(AGY)).toMatchObject({ status: 'declined', reason: "No answer within 24 h, so the default (Don't agree) applied" });
		expect(threadTexts(h).join('\n')).toMatch(/No answer within 24 h, so nothing was accepted/);
	});

	it('Settings inline answer goes through the open card (the card updates)', async () => {
		const h = harness();
		await h.terms.requestConsent(AGY);
		await h.terms.answer(AGY, 'agree_no_data');
		await h.terms.whenIdle(AGY);
		const d = await h.decisions.get(h.store.get(AGY)?.decisionId ?? '');
		expect(d).toMatchObject({ status: 'resolved', answeredVia: 'dashboard' });
		expect(h.slack.updates.length).toBeGreaterThan(0);
		expect(h.tuis[0].accepted?.dataSharing).toBe(false);
	});

	it('already set up: nothing is pressed, the smoke test still runs', async () => {
		const h = harness({ alreadyAccepted: true });
		await h.terms.requestConsent(AGY);
		await click(h, 'Agree + share data');
		expect(h.tuis[0].keys).toEqual([]);
		expect(h.store.get(AGY)?.status).toBe('accepted');
		expect(threadTexts(h)[0]).toMatch(/was already set up/);
		expect(h.smoke).toHaveBeenCalled();
	});

	it('a thumbs-up or "yes" is not an answer (two ways to agree); ❌ means Don\'t agree', async () => {
		const h = harness();
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		const d = await h.decisions.get(h.store.get(AGY)?.decisionId ?? '');
		const card = d?.card as NonNullable<typeof d>['card'];
		expect((await h.decisions.handleReaction({ user: OWNER, reaction: 'white_check_mark', item: { channel: card?.slackChannelId, ts: card?.messageTs } })).handled).toBe(false);
		expect(
			(await h.decisions.handleThreadReply({ channelId: DM, threadTs: card?.messageTs, ts: '999.1', text: 'yes', userId: OWNER })).handled,
		).toBe(false);
		expect((await h.decisions.handleReaction({ user: OWNER, reaction: 'x', item: { channel: card?.slackChannelId, ts: card?.messageTs } })).handled).toBe(true);
		await h.terms.whenIdle(AGY);
		expect(h.store.get(AGY)?.status).toBe('declined');
	});

	it('writes English only (card, thread replies, reasons)', async () => {
		const h = harness({ changedTerms: true });
		await h.terms.reportTermsScreen(AGY, { source: 'launch' });
		await click(h, 'Agree, no data sharing');
		await fs.mkdir(path.join(dir, 'second'));
		const h2 = harness({}, path.join(dir, 'second'));
		await h2.terms.reportTermsScreen(AGY, { source: 'launch' });
		await click(h2, "Don't agree");
		const texts = [...h.slack.sent, ...h2.slack.sent].map((m) => `${m.text} ${JSON.stringify(m.blocks ?? [])}`);
		texts.push(h.terms.blockedReason(AGY) ?? '', h2.terms.blockedReason(AGY) ?? '');
		for (const t of texts) expect(t).not.toMatch(CJK);
	});
});

describe('helpers', () => {
	it('choiceOfLabel', () => {
		expect(choiceOfLabel('Agree, no data sharing')).toBe('agree_no_data');
		expect(choiceOfLabel('Agree + share data')).toBe('agree_share_data');
		expect(choiceOfLabel("Don't agree")).toBe('decline');
		expect(choiceOfLabel('Maybe')).toBeNull();
	});

	it('screenForThread fences, trims and redacts', () => {
		const out = screenForThread('line ```x```\nGEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstu\n\n');
		expect(out.startsWith('```\n')).toBe(true);
		expect(out).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstu');
		expect(out.match(/```/g)).toHaveLength(2);
	});
});

describe('list', () => {
	it('shows every runtime with a Terms flow, with its state and the inline choices', async () => {
		const h = harness();
		expect(h.terms.list()).toEqual([
			expect.objectContaining({ runtime: AGY, status: 'none', label: 'Antigravity CLI', blockedReason: null, choices: expect.any(Array) }),
		]);
		await h.terms.reportTermsScreen(AGY, { source: 'probe' });
		const [view] = h.terms.list();
		expect(view).toMatchObject({ status: 'pending', decisionId: expect.stringMatching(/^D-/) });
		expect(view.choices.map((c) => c.label)).toEqual(['Agree, no data sharing', 'Agree + share data', "Don't agree"]);
	});
});

describe('probe', () => {
	it('a Terms screen asks the owner; nothing is pressed', async () => {
		const h = harness();
		const out = await h.terms.probe(AGY);
		expect(out.outcome).toBe('terms');
		expect(h.tuis[0].keys).toEqual([]);
		expect(h.closed).toEqual(['dedicated']);
		expect(h.store.get(AGY)).toMatchObject({ status: 'pending', detectedBy: 'probe' });
		expect(h.slack.sent.filter((m) => m.blocks)).toHaveLength(1);
	});

	it('a ready prompt means the Terms were accepted here already', async () => {
		const h = harness({ alreadyAccepted: true });
		h.store.set({ runtime: AGY, status: 'declined', reason: 'x', updatedAt: 'then' });
		const out = await h.terms.probe(AGY);
		expect(out.outcome).toBe('ready');
		expect(h.store.get(AGY)).toMatchObject({ status: 'accepted', detectedBy: 'probe' });
		expect(h.terms.blockedReason(AGY)).toBeNull();
		expect(h.slack.sent).toHaveLength(0);
	});
});
