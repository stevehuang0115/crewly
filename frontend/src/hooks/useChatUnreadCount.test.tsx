import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_SEEN_STORAGE_KEY, countUnread, markChatSeen, readChatSeen, useChatUnreadCount } from './useChatUnreadCount';

const Probe: React.FC<{ onChat: boolean }> = ({ onChat }) => {
	const n = useChatUnreadCount(onChat);
	return <div data-testid="n">{n === null ? 'null' : String(n)}</div>;
};

function channelsResponse(channels: unknown[]) {
	return { ok: true, json: () => Promise.resolve({ success: true, data: { channels, nextCursor: null } }) } as unknown as Response;
}

describe('countUnread', () => {
	it('counts channels with activity after the last seen time (global or per channel)', () => {
		const channels = [
			{ id: 'a', lastMessageAt: 100 },
			{ id: 'b', lastMessageAt: 300 },
			{ id: 'c', lastMessageAt: 300 },
			{ id: 'd', lastMessageAt: null },
			{ id: 'e', lastMessageAt: 500, archivedAt: 400 },
		];
		expect(countUnread(channels, { all: 200 })).toBe(2);
		expect(countUnread(channels, { all: 200, c: 400 })).toBe(1);
		expect(countUnread(channels, {})).toBe(3);
	});
});

describe('chat seen record', () => {
	beforeEach(() => window.localStorage.clear());

	it('stores a global and per-channel time', () => {
		markChatSeen(undefined, 10);
		markChatSeen('ch-1', 20);
		expect(readChatSeen()).toEqual({ all: 10, 'ch-1': 20 });
	});

	it('survives bad stored data', () => {
		window.localStorage.setItem(CHAT_SEEN_STORAGE_KEY, '{not json');
		expect(readChatSeen()).toEqual({});
	});
});

describe('useChatUnreadCount', () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => vi.restoreAllMocks());

	it('counts unread conversations from /api/chat/channels', async () => {
		markChatSeen(undefined, 200);
		global.fetch = vi.fn().mockResolvedValue(channelsResponse([{ id: 'a', lastMessageAt: 100 }, { id: 'b', lastMessageAt: 300 }]));
		render(<Probe onChat={false} />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('1'));
		expect(global.fetch).toHaveBeenCalledWith('/api/chat/channels');
	});

	it('is 0 on the Chat page and marks everything seen', async () => {
		global.fetch = vi.fn();
		render(<Probe onChat />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('0'));
		expect(global.fetch).not.toHaveBeenCalled();
		expect(readChatSeen().all).toBeGreaterThan(0);
	});

	it('stays unknown when the request fails', async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error('down'));
		render(<Probe onChat={false} />);
		await waitFor(() => expect(global.fetch).toHaveBeenCalled());
		expect(screen.getByTestId('n')).toHaveTextContent('null');
	});
});
