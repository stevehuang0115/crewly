/**
 * Tests for GmailReplyWatchService (CREW-257): one event per new reply, none
 * for history or the owner's own mail, none repeated after a restart, none for
 * a disconnected account.
 *
 * @module services/google/gmail-reply-watch.service.test
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type { GmailThreadMessage } from './gmail.service.js';
import { GmailReplyWatchService, type GmailReplyWatchDeps } from './gmail-reply-watch.service.js';

const msg = (id: string, labelIds: string[] = ['INBOX']): GmailThreadMessage => ({ id, from: 'them@x.y', subject: 'Re: hi', snippet: '', labelIds });

let file: string;
let thread: GmailThreadMessage[];
let connected: boolean;
let events: AgentEvent[];

function make(): GmailReplyWatchService {
	const deps: GmailReplyWatchDeps = {
		file,
		getThread: async () => thread,
		accountConnected: async () => connected,
		defaultAccount: async () => 'owner@x.y',
		publish: (e) => events.push(e),
	};
	return new GmailReplyWatchService(deps);
}

beforeEach(async () => {
	file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gmail-watch-')), 'watches.json');
	thread = [msg('m1', ['SENT'])];
	connected = true;
	events = [];
});

describe('GmailReplyWatchService', () => {
	it('does not fire for history, fires once for a new reply with the thread id and owner', async () => {
		const svc = make();
		await svc.watch('t1', 'lyra');
		expect(await svc.poll()).toBe(0);
		thread = [...thread, msg('m2')];
		expect(await svc.poll()).toBe(1);
		expect(await svc.poll()).toBe(0);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'gmail:reply_received', threadId: 't1', target: 'lyra', newValue: 'm2' });
		// self-event rule: the event's session is never the owning agent
		expect(events[0].sessionName).not.toBe('lyra');
	});

	it('ignores the owner\'s own messages and drafts', async () => {
		const svc = make();
		await svc.watch('t1', 'lyra');
		thread = [...thread, msg('m2', ['SENT']), msg('m3', ['DRAFT'])];
		expect(await svc.poll()).toBe(0);
	});

	it('does not repeat after a restart', async () => {
		const first = make();
		await first.watch('t1', 'lyra');
		thread = [...thread, msg('m2')];
		await first.poll();
		const restarted = make();
		expect(await restarted.poll()).toBe(0);
		expect(events).toHaveLength(1);
		thread = [...thread, msg('m3')];
		expect(await restarted.poll()).toBe(1);
	});

	it('fires nothing for an account that is no longer connected', async () => {
		const svc = make();
		await svc.watch('t1', 'lyra');
		thread = [...thread, msg('m2')];
		connected = false;
		expect(await svc.poll()).toBe(0);
		connected = true;
		expect(await svc.poll()).toBe(1);
	});

	it('only the owning agent can remove a watch', async () => {
		const svc = make();
		await svc.watch('t1', 'lyra');
		expect(await svc.unwatch('t1', 'someone-else')).toBe(false);
		expect(await svc.unwatch('t1', 'lyra')).toBe(true);
		expect(await svc.list()).toHaveLength(0);
	});
});
