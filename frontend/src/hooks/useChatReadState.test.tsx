import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Channel, ChatApiClient } from '@crewly/chat-ui';
import { useChatReadState } from './useChatReadState';

const ch = (id: string, lastReadSeq: number, unreadCount: number): Channel => ({
	id,
	agentSession: 's',
	name: id,
	createdAt: '2026-10-21T00:00:00.000Z',
	type: 'dm',
	lastReadSeq,
	unreadCount,
});

function fakeClient() {
	const client = {
		markChannelRead: vi.fn(async (channelId: string) => ({ channelId, lastReadSeq: 9, unreadCount: 0 })),
		markChannelUnread: vi.fn(async (channelId: string, seq: number) => ({ channelId, lastReadSeq: seq - 1, unreadCount: 2 })),
	};
	return client as typeof client & ChatApiClient;
}

type Props = { channels: Channel[]; openId: string | null; ready?: boolean };

function setup(client: ChatApiClient, initial: Props) {
	return renderHook(
		(p: Props) =>
			useChatReadState({ client, channels: p.channels, ready: p.ready ?? true, openId: p.openId, idsOf: (id) => (id === 'orc' ? ['orc', 'slack-1'] : [id]) }),
		{ initialProps: initial },
	);
}

describe('useChatReadState', () => {
	it('reports per-conversation counts from the list, summing an orchestrator group', () => {
		const { result } = setup(fakeClient(), { channels: [ch('a', 0, 2), ch('orc', 0, 1), ch('slack-1', 0, 3)], openId: null });
		expect(result.current.unreadCountOf('a')).toBe(2);
		expect(result.current.unreadCountOf('orc')).toBe(4);
		expect(result.current.unreadCountOf('missing')).toBe(0);
	});

	it('opening a conversation marks it read and pins the divider to the marker at open time', async () => {
		const client = fakeClient();
		const { result } = setup(client, { channels: [ch('a', 4, 2)], openId: 'a' });
		expect(result.current.unreadAfterSeq).toBe(4);
		await waitFor(() => expect(client.markChannelRead).toHaveBeenCalledWith('a'));
		await waitFor(() => expect(result.current.unreadCountOf('a')).toBe(0));
		// Read now, but the divider stays so the owner can see what was new.
		expect(result.current.unreadAfterSeq).toBe(4);
	});

	it('draws no divider when nothing was unread, and does not call the server', () => {
		const client = fakeClient();
		const { result } = setup(client, { channels: [ch('a', 4, 0)], openId: 'a' });
		expect(result.current.unreadAfterSeq).toBeNull();
		expect(client.markChannelRead).not.toHaveBeenCalled();
	});

	it('does not mark read while no conversation is on screen', () => {
		const client = fakeClient();
		setup(client, { channels: [ch('a', 0, 5)], openId: null });
		expect(client.markChannelRead).not.toHaveBeenCalled();
	});

	it('waits for the list to load before marking read', async () => {
		const client = fakeClient();
		const { rerender } = setup(client, { channels: [], openId: 'a', ready: false });
		expect(client.markChannelRead).not.toHaveBeenCalled();
		rerender({ channels: [ch('a', 0, 3)], openId: 'a', ready: true });
		await waitFor(() => expect(client.markChannelRead).toHaveBeenCalledWith('a'));
	});

	it('keeps marking read when a live read_state frame raises the count while open', async () => {
		const client = fakeClient();
		const { result } = setup(client, { channels: [ch('a', 4, 0)], openId: 'a' });
		act(() => result.current.applyReadState({ channelId: 'a', lastReadSeq: 4, unreadCount: 1 }));
		await waitFor(() => expect(client.markChannelRead).toHaveBeenCalledWith('a'));
	});

	it('Mark unread moves the divider and stops auto-reading until the conversation is reopened', async () => {
		const client = fakeClient();
		const { result, rerender } = setup(client, { channels: [ch('a', 9, 0)], openId: 'a' });
		await act(async () => {
			await result.current.markUnread('a', 7);
		});
		expect(client.markChannelUnread).toHaveBeenCalledWith('a', 7);
		expect(result.current.unreadAfterSeq).toBe(6);
		expect(result.current.unreadCountOf('a')).toBe(2);
		// Held: more unread arrives, still not auto-read.
		act(() => result.current.applyReadState({ channelId: 'a', lastReadSeq: 6, unreadCount: 3 }));
		await new Promise((r) => setTimeout(r, 20));
		expect(client.markChannelRead).not.toHaveBeenCalled();
		// Leave and reopen: reads again.
		rerender({ channels: [ch('a', 6, 3)], openId: null });
		rerender({ channels: [ch('a', 6, 3)], openId: 'a' });
		await waitFor(() => expect(client.markChannelRead).toHaveBeenCalledWith('a'));
	});

	it('Mark unread in a merged conversation holds auto-read but draws no divider', async () => {
		const client = fakeClient();
		const { result } = setup(client, { channels: [ch('orc', 3, 0), ch('slack-1', 3, 0)], openId: 'orc' });
		await act(async () => {
			await result.current.markUnread('slack-1', 2);
		});
		expect(client.markChannelUnread).toHaveBeenCalledWith('slack-1', 2);
		expect(result.current.unreadAfterSeq).toBeNull();
		expect(result.current.unreadCountOf('orc')).toBe(2);
		await new Promise((r) => setTimeout(r, 20));
		expect(client.markChannelRead).not.toHaveBeenCalled();
	});

	it('releases the hold when Mark unread fails', async () => {
		const client = fakeClient();
		client.markChannelUnread.mockRejectedValueOnce(new Error('down'));
		const { result } = setup(client, { channels: [ch('a', 4, 0)], openId: 'a' });
		await act(async () => {
			await result.current.markUnread('a', 3);
		});
		act(() => result.current.applyReadState({ channelId: 'a', lastReadSeq: 4, unreadCount: 1 }));
		await waitFor(() => expect(client.markChannelRead).toHaveBeenCalled());
	});

	it('copes with a client that has no read-state methods', () => {
		const bare = {} as ChatApiClient;
		const { result } = setup(bare, { channels: [ch('a', 0, 2)], openId: 'a' });
		expect(result.current.unreadCountOf('a')).toBe(2);
		return expect(result.current.markUnread('a', 1)).resolves.toBeUndefined();
	});
});
