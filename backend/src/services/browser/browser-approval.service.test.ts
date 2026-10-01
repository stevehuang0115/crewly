/**
 * Tests for owner approval of held browser actions: the hold becomes a Slack
 * decision card in the agent's work-item thread (from its own bot); every
 * answer surface resolves the same hold; timeout means No; the hold survives
 * a restart (re-attached or expired). Real BrowserSessionService,
 * DecisionService and stores; Slack is mocked; one injected clock.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BROWSER_APPROVAL_CONSTANTS } from '../../constants.js';
import { DecisionService, type DecisionServiceDeps, type DecisionSlackApi, type BlockActionsPayload } from '../decisions/decision.service.js';
import { DecisionStore } from '../decisions/decision-store.js';
import { TicketThreadStore } from '../decisions/ticket-thread-store.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { SlackBlock, SlackOutgoingMessage } from '../../types/slack.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { BrowserSessionService, HELD_ACTION_FALLBACK_LINE } from './browser-session.service.js';
import {
	BrowserApprovalService,
	CARD_ASKED_LINE,
	approvalQuestion,
	controlName,
	describeTarget,
	placeOf,
	type BrowserApprovalDeps,
} from './browser-approval.service.js';
import { HeldActionStore } from './held-action-store.js';

const quiet = (): ComponentLogger => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;
const OWNER = 'U-OWNER';
const AGENT = 'ce-vera';
const SUBMIT = { selector: 'button:has-text("Submit")' };
const CJK = /[㐀-鿿]/;

/** Records Slack Web API calls. */
class FakeSlack implements DecisionSlackApi {
	sent: SlackOutgoingMessage[] = [];
	updates: Array<{ channelId: string; ts: string; text: string; blocks?: SlackBlock[]; botToken?: string }> = [];
	connected = true;
	private n = 0;
	isConnected(): boolean {
		return this.connected;
	}
	async sendMessage(m: SlackOutgoingMessage): Promise<string> {
		this.sent.push(m);
		this.n += 1;
		return `300.${String(this.n).padStart(4, '0')}`;
	}
	async updateMessage(channelId: string, ts: string, text: string, blocks?: SlackBlock[], botToken?: string): Promise<void> {
		this.updates.push({ channelId, ts, text, blocks, botToken });
	}
}

let dir: string;
const clock = { ms: 0 };

interface World {
	sessions: BrowserSessionService;
	decisions: DecisionService;
	approvals: BrowserApprovalService;
	slack: FakeSlack;
	/** Notes delivered to agents (via the decision service and directly) */
	told: Array<{ session: string; text: string }>;
	bindings: Map<string, { tabId: number; instanceId?: string }>;
	adopted: Array<[string, number]>;
}

/** Build one "process": fresh in-memory services over the same files. */
function boot(over: { slack?: FakeSlack; canAsk?: boolean; approvals?: Partial<BrowserApprovalDeps> } = {}): World {
	BrowserSessionService.resetInstance();
	const sessions = BrowserSessionService.getInstance();
	const slack = over.slack ?? new FakeSlack();
	const told: World['told'] = [];
	const deps: DecisionServiceDeps = {
		store: new DecisionStore(path.join(dir, 'decisions.json'), () => new Date(clock.ms)),
		threads: TicketThreadStore.inHome(dir),
		slack: () => slack,
		instanceId: () => 'inst-1',
		isOwner: (u) => u === OWNER,
		ownerUserId: () => OWNER,
		userName: async () => 'Steve',
		identityOf: async (s) => (s === AGENT ? { botToken: 'xoxb-vera', username: 'Vera' } : { username: s }),
		teamChannelOf: async () => 'C-TEAM',
		teamOf: async () => 'team-ce',
		resolveTicket: async () => {
			throw new Error('no tickets here');
		},
		markTicketAsked: async () => undefined,
		logTicket: async () => undefined,
		currentWorkItemId: async () => 'WI-7',
		workDestination: async (s) => (s === AGENT ? { slackChannelId: 'C-PRO-CE', threadTs: '111.0001' } : null),
		deliverToAgent: async (session, text) => {
			told.push({ session, text });
			return true;
		},
		now: () => new Date(clock.ms),
		logger: quiet(),
	};
	const decisions = new DecisionService(deps);
	const bindings = new Map<string, { tabId: number; instanceId?: string }>([[AGENT, { tabId: 42 }]]);
	const adopted: World['adopted'] = [];
	const approvals = new BrowserApprovalService({
		store: new HeldActionStore(path.join(dir, 'held.json'), () => clock.ms),
		sessions,
		decisions: () => decisions,
		canAskInSlack: () => over.canAsk ?? slack.isConnected(),
		tellAgent: async (session, text) => void told.push({ session, text }),
		agentNameOf: async (s) => (s === AGENT ? 'Vera' : undefined),
		boundTabOf: (s) => bindings.get(s),
		adoptTab: (s, tabId, instanceId) => {
			adopted.push([s, tabId]);
			bindings.set(s, { tabId, ...(instanceId ? { instanceId } : {}) });
			return true;
		},
		now: () => clock.ms,
		logger: quiet(),
		...over.approvals,
	});
	DecisionService.registerKindHandler('browser_action', approvals);
	sessions.setHoldListener(approvals);
	return { sessions, decisions, approvals, slack, told, bindings, adopted };
}

/** Vera opens the subscribe page and tries to click Submit (held). */
async function holdSubmit(w: World): Promise<{ reason: string; pendingId: string; decision: OwnerDecision }> {
	w.sessions.noteAction({ agentSession: AGENT, tool: 'navigate', params: { url: 'https://visa.careerengine.us/subscribe?ref=x' } });
	const verdict = w.sessions.authorize(AGENT, 'click', SUBMIT);
	if (verdict.allow) throw new Error('expected a hold');
	await w.approvals.idle();
	const [decision] = await w.decisions.list('all');
	return { reason: verdict.reason, pendingId: verdict.pendingId!, decision };
}

function click(d: OwnerDecision, option: string): BlockActionsPayload {
	return {
		type: 'block_actions',
		user: { id: OWNER },
		actions: [{ action_id: `decision:${option}`, value: JSON.stringify({ d: d.id, o: option, i: 'inst-1' }) }],
		container: { channel_id: d.card!.slackChannelId, message_ts: d.card!.messageTs },
	};
}

const reply = (d: OwnerDecision, text: string) => ({ channelId: 'C-PRO-CE', threadTs: '111.0001', ts: '400.1', text, userId: OWNER });
const lastUpdate = (w: World) => w.slack.updates[w.slack.updates.length - 1];
const agentNotes = (w: World) => w.told.filter((t) => t.session === AGENT).map((t) => t.text);
const allText = (w: World) => [...w.slack.sent.map((m) => JSON.stringify([m.text, m.blocks])), ...w.slack.updates.map((u) => JSON.stringify([u.text, u.blocks])), ...w.told.map((t) => t.text)];

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-approval-'));
	clock.ms = new Date(2026, 9, 1, 22, 0, 0).getTime();
	jest.spyOn(Date, 'now').mockImplementation(() => clock.ms);
});
afterEach(async () => {
	jest.restoreAllMocks();
	DecisionService.registerKindHandler('browser_action', null);
	BrowserSessionService.resetInstance();
	await fs.rm(dir, { recursive: true, force: true });
});

describe('helpers', () => {
	it('names the control, the place and the question', () => {
		expect(controlName({ selector: 'button:has-text("Submit")' })).toBe('Submit');
		expect(controlName({ selector: 'button[aria-label="Send now"]' })).toBe('Send now');
		expect(controlName({ selector: 'text=Pay' })).toBe('Pay');
		expect(controlName({ text: 'Delete' })).toBe('Delete');
		expect(controlName({ selector: '#go' })).toBe('#go');
		expect(describeTarget('click', SUBMIT)).toBe('click "Submit"');
		expect(describeTarget('pressKey', { key: 'Enter' })).toBe('press Enter');
		expect(placeOf('https://visa.careerengine.us/subscribe/?a=1')).toBe('visa.careerengine.us/subscribe');
		expect(placeOf(undefined)).toBeUndefined();
		expect(approvalQuestion('Vera', { target: 'click "Submit"', where: 'visa.careerengine.us/subscribe', matched: 'submitting' })).toBe(
			'Vera wants to click "Submit" on visa.careerengine.us/subscribe — it looks like submitting and can\'t be undone.',
		);
	});
});

describe('a held action asks the owner with a card', () => {
	it('posts the card in the work-item thread from the agent\'s own bot, with Let it / No and no snooze', async () => {
		const w = boot();
		const { reason, pendingId, decision } = await holdSubmit(w);

		expect(reason).toContain(BROWSER_APPROVAL_CONSTANTS.AGENT_SAYS);
		expect(reason).toContain('do not tell anyone to approve it in Chrome');
		expect(w.slack.sent).toHaveLength(1);
		const card = w.slack.sent[0];
		expect(card).toMatchObject({ channelId: 'C-PRO-CE', threadTs: '111.0001', botToken: 'xoxb-vera' });
		expect(card.text).toContain('Vera wants to click "Submit" on visa.careerengine.us/subscribe');
		const actions = (card.blocks as unknown as Array<{ type: string; elements?: Array<{ text: { text: string }; style?: string }> }>).find((b) => b.type === 'actions')!;
		expect(actions.elements!.map((e) => e.text.text)).toEqual(['Let it', 'No']);
		expect(actions.elements!.some((e) => e.style === 'primary')).toBe(false);

		expect(decision).toMatchObject({
			kind: 'browser_action',
			sensitive: 'browser_action',
			defaultKey: 'b',
			yesKey: 'a',
			asker: AGENT,
			workItemId: 'WI-7',
			browser: { agentSession: AGENT, agentName: 'Vera', pendingId, where: 'visa.careerengine.us/subscribe', target: 'click "Submit"' },
		});
		expect(Date.parse(decision.deadline) - clock.ms).toBe(BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS);

		// Persisted, linked to the card, without the call's params.
		const file = JSON.parse(await fs.readFile(path.join(dir, 'held.json'), 'utf8'));
		expect(file.actions[0]).toMatchObject({ pendingId, agentSession: AGENT, tabId: 42, decisionId: decision.id, status: 'pending' });
		expect(JSON.stringify(file)).not.toContain('selector');

		// Retrying while held is refused with the same guidance; no second card.
		const again = w.sessions.authorize(AGENT, 'click', SUBMIT);
		expect(again).toMatchObject({ allow: false, code: 'awaiting_owner', pendingId });
		expect(!again.allow && again.reason).toContain(BROWSER_APPROVAL_CONSTANTS.AGENT_SAYS);
		await w.approvals.idle();
		expect(w.slack.sent).toHaveLength(1);
	});

	it('without Slack the agent is pointed at the dashboard, and the card is made once Slack is back', async () => {
		const slack = new FakeSlack();
		slack.connected = false;
		const w = boot({ slack });
		const { reason } = await holdSubmit(w);
		expect(reason).toContain(HELD_ACTION_FALLBACK_LINE);
		expect(reason).not.toContain(CARD_ASKED_LINE);
		expect(w.slack.sent).toHaveLength(0);

		slack.connected = true;
		expect(await w.approvals.tick()).toHaveLength(1);
		expect(w.slack.sent).toHaveLength(1);
	});
});

describe('every answer surface resolves the one held action', () => {
	const approvedVia: Array<[string, (w: World, d: OwnerDecision, pendingId: string) => Promise<unknown>]> = [
		['the card button', (w, d) => w.decisions.handleInteraction(click(d, 'a'))],
		['a ✅ reaction', (w, d) => w.decisions.handleReaction({ user: OWNER, reaction: 'white_check_mark', item: { type: 'message', channel: d.card!.slackChannelId, ts: d.card!.messageTs } })],
		['a "批准" reply', (w, d) => w.decisions.handleThreadReply(reply(d, '批准'))],
		['a "可以" reply', (w, d) => w.decisions.handleThreadReply(reply(d, '可以'))],
		['a "好" reply', (w, d) => w.decisions.handleThreadReply(reply(d, '好'))],
		['a "yes" reply', (w, d) => w.decisions.handleThreadReply(reply(d, 'yes'))],
		['a "Let it" reply', (w, d) => w.decisions.handleThreadReply(reply(d, 'Let it'))],
		['the decisions dashboard', (w, d) => w.decisions.chooseFromDashboard(d.id, 'a')],
		['the Browser page (dashboard / portal)', (w, _d, pendingId) => w.approvals.answerFromBrowserPage(AGENT, pendingId, 'approve')],
	];

	it.each(approvedVia)('approve via %s: card says Let it, agent told once, the click goes through once', async (_name, answer) => {
		const w = boot();
		const { pendingId, decision } = await holdSubmit(w);
		await answer(w, decision, pendingId);
		await w.approvals.idle();

		expect(lastUpdate(w).text).toContain('✔ Steve chose *Let it*');
		expect(lastUpdate(w).botToken).toBe('xoxb-vera');
		expect(await w.decisions.get(decision.id)).toMatchObject({ status: 'resolved', chosenKey: 'a' });
		const notes = agentNotes(w);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('[BROWSER] The owner said Let it: click "Submit" on visa.careerengine.us/subscribe');

		// The held click itself now goes through — exactly once.
		expect(w.sessions.getSession(AGENT)?.pending).toBeUndefined();
		expect(w.sessions.authorize(AGENT, 'click', SUBMIT)).toEqual({ allow: true });
		expect(w.sessions.authorize(AGENT, 'click', SUBMIT).allow).toBe(false);
		await w.approvals.idle();

		const file = JSON.parse(await fs.readFile(path.join(dir, 'held.json'), 'utf8'));
		expect(file.actions.find((a: { pendingId: string }) => a.pendingId === pendingId).status).toBe('approved');
		// A second answer changes nothing.
		expect(await w.approvals.answerFromBrowserPage(AGENT, pendingId, 'reject')).toBeUndefined();
	});

	const rejectedVia: Array<[string, (w: World, d: OwnerDecision, pendingId: string) => Promise<unknown>]> = [
		['the card button', (w, d) => w.decisions.handleInteraction(click(d, 'b'))],
		['a ❌ reaction', (w, d) => w.decisions.handleReaction({ user: OWNER, reaction: 'x', item: { type: 'message', channel: d.card!.slackChannelId, ts: d.card!.messageTs } })],
		['a "不行" reply', (w, d) => w.decisions.handleThreadReply(reply(d, '不行'))],
		['a "不要" reply', (w, d) => w.decisions.handleThreadReply(reply(d, '不要'))],
		['a "no" reply', (w, d) => w.decisions.handleThreadReply(reply(d, 'no'))],
		['the Browser page', (w, _d, pendingId) => w.approvals.answerFromBrowserPage(AGENT, pendingId, 'reject')],
	];

	it.each(rejectedVia)('reject via %s: card says No, agent told not to, the click stays held', async (_name, answer) => {
		const w = boot();
		const { pendingId, decision } = await holdSubmit(w);
		await answer(w, decision, pendingId);
		await w.approvals.idle();

		expect(lastUpdate(w).text).toContain('✔ Steve chose *No*');
		const notes = agentNotes(w);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('[BROWSER] The owner said No to: click "Submit"');
		expect(w.sessions.getSession(AGENT)?.pending).toBeUndefined();
		// Trying again is a new hold, not a pass.
		expect(w.sessions.authorize(AGENT, 'click', SUBMIT).allow).toBe(false);
		await w.approvals.idle();
	});

	it('words that are neither yes nor no, and snooze, leave it open', async () => {
		const w = boot();
		const { decision } = await holdSubmit(w);
		expect(await w.decisions.handleThreadReply(reply(decision, 'what form is this?'))).toMatchObject({ handled: false });
		expect(await w.decisions.handleThreadReply(reply(decision, 'tomorrow'))).toMatchObject({ handled: false });
		expect(
			await w.decisions.handleReaction({ user: OWNER, reaction: 'alarm_clock', item: { type: 'message', channel: decision.card!.slackChannelId, ts: decision.card!.messageTs } }),
		).toMatchObject({ handled: false });
		expect((await w.decisions.get(decision.id))?.status).toBe('open');
		expect(w.sessions.getSession(AGENT)?.pending).toBeDefined();
	});

	it('the owner taking the wheel and giving it back withdraws the card', async () => {
		const w = boot();
		const { decision } = await holdSubmit(w);
		w.sessions.takeControl(AGENT);
		w.sessions.releaseControl(AGENT);
		await w.approvals.idle();
		expect((await w.decisions.get(decision.id))?.status).toBe('cancelled');
		expect(lastUpdate(w).text).toContain('Withdrawn');
		expect(agentNotes(w)).toEqual([]);
	});
});

describe('timeout', () => {
	it('no answer within the deadline → No: card updated, agent told, nothing let through', async () => {
		const w = boot();
		const { decision } = await holdSubmit(w);
		clock.ms += BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS - 1000;
		expect(await w.decisions.tick()).toEqual([]);
		clock.ms += 2000;
		expect(await w.decisions.tick()).toEqual([decision.id]);

		expect(await w.decisions.get(decision.id)).toMatchObject({ status: 'defaulted', chosenKey: 'b' });
		expect(lastUpdate(w).text).toContain('going with No');
		const notes = agentNotes(w);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('so the answer is No');
		expect(w.sessions.getSession(AGENT)?.pending).toBeUndefined();
		expect(w.sessions.authorize(AGENT, 'click', SUBMIT).allow).toBe(false);
		await w.approvals.idle();
	});

	it('a hold that never got a card still times out to No', async () => {
		const slack = new FakeSlack();
		slack.connected = false;
		const w = boot({ slack });
		await holdSubmit(w);
		clock.ms += BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS + 1;
		await w.approvals.tick();
		expect(agentNotes(w)[0]).toContain('so the answer is No');
		expect(w.sessions.getSession(AGENT)?.pending).toBeUndefined();
	});
});

describe('restart', () => {
	it('re-attaches the hold when its tab comes back, and the card still answers it', async () => {
		const first = boot();
		const { pendingId, decision } = await holdSubmit(first);

		// Crewly restarts: memory is gone, files remain.
		const w = boot({ slack: first.slack });
		w.bindings.clear();
		expect(w.sessions.getSession(AGENT)).toBeUndefined();
		expect(await w.approvals.restore()).toBe(1);

		w.approvals.onTabInventory([{ tabId: 7 }, { tabId: 42, crewlyOwned: true }]);
		await w.approvals.idle();
		expect(w.adopted).toEqual([[AGENT, 42]]);
		expect(w.sessions.getSession(AGENT)).toMatchObject({ status: 'waiting_owner', tabId: 42, pending: { id: pendingId } });
		const retry = w.sessions.authorize(AGENT, 'click', SUBMIT);
		expect(!retry.allow && retry.reason).toContain(BROWSER_APPROVAL_CONSTANTS.AGENT_SAYS);

		// The grace period passing does not expire a re-attached hold.
		clock.ms += BROWSER_APPROVAL_CONSTANTS.REBIND_GRACE_MS + 1;
		await w.approvals.tick();
		expect((await w.decisions.get(decision.id))?.status).toBe('open');

		await w.decisions.handleThreadReply(reply(decision, '批准'));
		expect(agentNotes(w)).toHaveLength(1);
		expect(agentNotes(w)[0]).toContain('The owner said Let it');
		expect(w.sessions.authorize(AGENT, 'click', SUBMIT)).toEqual({ allow: true });
	});

	it('expires the hold when its tab never comes back: card says Expired, agent told to redo the step', async () => {
		const first = boot();
		const { pendingId, decision } = await holdSubmit(first);
		const w = boot({ slack: first.slack });
		w.bindings.clear();
		await w.approvals.restore();

		w.approvals.onTabInventory([{ tabId: 7 }]);
		await w.approvals.idle();
		clock.ms += BROWSER_APPROVAL_CONSTANTS.REBIND_GRACE_MS - 1;
		await w.approvals.tick();
		expect((await w.decisions.get(decision.id))?.status).toBe('open');

		clock.ms += 2;
		expect(await w.approvals.tick()).toEqual([pendingId]);
		expect((await w.decisions.get(decision.id))?.status).toBe('expired');
		expect(lastUpdate(w).text).toContain('Expired — Vera will ask again');
		const notes = agentNotes(w);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('could not be re-attached to its tab, so it expired. Redo the step');
		const file = JSON.parse(await fs.readFile(path.join(dir, 'held.json'), 'utf8'));
		expect(file.actions[0].status).toBe('expired');

		// Redoing the step asks again with a new card.
		const again = w.sessions.authorize(AGENT, 'click', SUBMIT);
		expect(again.allow).toBe(false);
		await w.approvals.idle();
		expect((await w.decisions.list('open')).length).toBe(1);
	});

	it('a hold without a known tab expires as soon as it is restored', async () => {
		const first = boot();
		first.bindings.clear();
		const { decision } = await holdSubmit(first);
		const w = boot({ slack: first.slack });
		await w.approvals.restore();
		expect((await w.decisions.get(decision.id))?.status).toBe('expired');
		expect(agentNotes(w)[0]).toContain('Redo the step');
	});
});

describe('English', () => {
	it('everything the harness writes is English (Chinese answers are still accepted)', async () => {
		const w = boot();
		const a = await holdSubmit(w);
		await w.decisions.handleThreadReply(reply(a.decision, '不行'));
		w.sessions.authorize(AGENT, 'click', SUBMIT);
		await w.approvals.idle();
		const [second] = await w.decisions.list('open');
		clock.ms += BROWSER_APPROVAL_CONSTANTS.DEADLINE_MS + 1;
		await w.decisions.tick();
		expect(second).toBeDefined();
		const texts = allText(w);
		expect(texts.length).toBeGreaterThan(4);
		for (const t of texts) expect(t).not.toMatch(CJK);
	});
});
