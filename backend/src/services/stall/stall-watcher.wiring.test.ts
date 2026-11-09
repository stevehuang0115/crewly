/**
 * Tests for the stall watcher's pure wiring pieces: assignment matching for
 * the claim check, the stall signal read from trace metrics, the chat-v2
 * message mapping, ticket-linked items and teammates.
 *
 * @module services/stall/stall-watcher.wiring.test
 */

import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TraceMetrics } from '../trace/trace-metrics.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import { ORCHESTRATOR_SESSION_NAME, PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { assignmentBackedBy, ongoingStallOf, stallLeadFor, teammatesOf, ticketLinkedIds, toStallMessage, type AssignmentTicket } from './stall-watcher.wiring.js';

const SAID = Date.parse('2026-10-16T23:54:00Z');
const MIN = 60_000;
const W = 10 * MIN;
const wi = (over: Partial<WorkItem> & { metadata?: Record<string, unknown> }): WorkItem =>
	({ id: 'w', status: 'queued', target: 'pia', owner: 'team_lead', createdAt: new Date(SAID + 3 * MIN).toISOString(), ...over }) as unknown as WorkItem;
const tk = (over: Partial<AssignmentTicket>): AssignmentTicket => ({ id: 'CREW-1', assignee: 'pia', source: 'agent:ella', createdAt: new Date(SAID - 2 * MIN).toISOString(), ...over });
const check = (items: WorkItem[], tickets: AssignmentTicket[] = []) => assignmentBackedBy({ items, tickets, speaker: 'ella', member: 'pia', saidAt: SAID, windowMs: W });

describe('assignmentBackedBy', () => {
	it('is false with nothing for the member (the 2026-10-16 case)', () => {
		expect(check([wi({ target: 'lyra', metadata: { delegatedBy: 'ella' } })], [tk({ assignee: 'dana' })])).toBe(false);
		expect(check([], [])).toBe(false);
	});
	it("counts the speaker's delegation, the harness's item, and an unstamped item in the window", () => {
		expect(check([wi({ metadata: { delegatedBy: 'ella' } })])).toBe(true);
		expect(check([wi({ metadata: { createdBy: 'ella' } })])).toBe(true);
		expect(check([wi({ owner: 'system', metadata: { harnessCreated: 'stated-intent' } })])).toBe(true);
		expect(check([wi({})])).toBe(true);
	});
	it("does not count another agent's delegation or an item outside the window", () => {
		expect(check([wi({ metadata: { delegatedBy: 'luna' } })])).toBe(false);
		expect(check([wi({ metadata: { delegatedBy: 'ella' }, createdAt: new Date(SAID + W + MIN).toISOString() })])).toBe(false);
		expect(check([wi({ metadata: { delegatedBy: 'ella' }, createdAt: new Date(SAID - W - MIN).toISOString() })])).toBe(false);
	});
	it('counts a ticket by the speaker, the harness or with no source; not one by someone else or outside the window', () => {
		expect(check([], [tk({})])).toBe(true);
		expect(check([], [tk({ source: 'harness:autopilot' })])).toBe(true);
		expect(check([], [tk({ source: null })])).toBe(true);
		expect(check([], [tk({ source: 'agent:luna' })])).toBe(false);
		expect(check([], [tk({ createdAt: new Date(SAID + W + MIN).toISOString() })])).toBe(false);
	});
});

describe('ongoingStallOf', () => {
	const metrics = (items: TraceMetrics['stalls']['items']): TraceMetrics => ({ stalls: { items } }) as unknown as TraceMetrics;
	it('returns the ongoing stall only', () => {
		expect(ongoingStallOf(null)).toBeNull();
		expect(ongoingStallOf(metrics([{ start: 'a', end: 'b', ms: 5000, cause: 'nobody_pushing', detail: 'x' }]))).toBeNull();
		expect(ongoingStallOf(metrics([{ start: 'a', end: 'b', ms: 5000, cause: 'nobody_pushing', detail: 'x' }, { start: 'c', end: 'd', ms: 31 * MIN, cause: 'runtime_quota', detail: 'quota', ongoing: true }]))).toEqual({
			ms: 31 * MIN,
			cause: 'runtime_quota',
			detail: 'quota',
		});
	});
});

describe('toStallMessage', () => {
	it('keeps the fields the watcher reads and counts attachments', () => {
		const dto = {
			id: 'm1',
			channelId: 'c',
			seq: 1,
			senderType: 'agent',
			senderId: 'rex',
			content: '已经开跑',
			contentType: 'text',
			createdAt: SAID,
			attachments: [{ id: 'a', mimeType: 'video/mp4', sizeBytes: 1, url: '/x' }],
			mentions: [],
			threadId: 'root',
			metadata: { interim: true },
		} as unknown as ChatMessageDTO;
		expect(toStallMessage(dto)).toEqual({ id: 'm1', channelId: 'c', threadId: 'root', senderType: 'agent', senderId: 'rex', content: '已经开跑', createdAt: SAID, attachmentCount: 1, metadata: { interim: true } });
		expect(toStallMessage({ ...dto, threadId: undefined, metadata: undefined, attachments: [] } as unknown as ChatMessageDTO)).toEqual({ id: 'm1', channelId: 'c', senderType: 'agent', senderId: 'rex', content: '已经开跑', createdAt: SAID, attachmentCount: 0 });
	});
});

describe('ticketLinkedIds', () => {
	it('finds the WorkItems a project ticket links to', () => {
		const linked = wi({ id: 'w-t', metadata: { [PROJECT_TICKET_CONSTANTS.WORK_ITEM_METADATA_KEY]: { projectPath: '/p', id: 'CREW-9' } } });
		expect([...ticketLinkedIds([linked, wi({ id: 'w-free' }), wi({ id: 'w-bad', metadata: { [PROJECT_TICKET_CONSTANTS.WORK_ITEM_METADATA_KEY]: { id: 'x' } } })])]).toEqual(['w-t']);
	});
});

describe('teammatesOf', () => {
	const teams = [
		{ id: 't1', name: 'FloPost', members: [{ id: '1', name: 'Ella', sessionName: 'ella', role: 'team-leader' }, { id: '2', name: 'Pia', sessionName: 'pia', role: 'member' }, { id: '3', name: '', sessionName: 'ghost', role: 'member' }] },
		{ id: 't2', name: 'Other', members: [{ id: '4', name: 'Rex', sessionName: 'rex', role: 'member' }] },
	] as unknown as Team[];
	it("lists the speaker's own teams' named members, without the speaker", () => {
		expect(teammatesOf(teams, 'ella')).toEqual([{ name: 'Pia', session: 'pia' }]);
		expect(teammatesOf(teams, 'rex')).toEqual([]);
		expect(teammatesOf(teams, 'nobody')).toEqual([]);
	});
});

describe('stallLeadFor', () => {
	const teams = [
		{ id: 't1', name: 'FloPost', members: [{ id: '1', name: 'Ella', sessionName: 'ella', role: 'team-leader' }, { id: '2', name: 'Pia', sessionName: 'pia', role: 'member' }] },
		{ id: 't2', name: 'Wang law', members: [{ id: '3', name: 'Owen', sessionName: 'owen', role: 'member' }] },
	] as unknown as Team[];
	it('is the team lead; the orchestrator when no lead runs here; nobody for the orchestrator (2026-10-22 audit)', () => {
		expect(stallLeadFor(teams, 'pia')).toBe('ella');
		expect(stallLeadFor(teams, 'owen')).toBe(ORCHESTRATOR_SESSION_NAME);
		expect(stallLeadFor(teams, ORCHESTRATOR_SESSION_NAME)).toBeNull();
	});
});
