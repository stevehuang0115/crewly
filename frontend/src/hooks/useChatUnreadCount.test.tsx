import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_UNREAD_API, notifyChatUnreadChanged, useChatUnreadCount } from './useChatUnreadCount';

const Probe: React.FC = () => {
	const n = useChatUnreadCount();
	return <div data-testid="n">{n === null ? 'null' : String(n)}</div>;
};

function unreadResponse(total: number) {
	return { ok: true, json: () => Promise.resolve({ success: true, data: { total, channels: [] } }) } as unknown as Response;
}

describe('useChatUnreadCount', () => {
	afterEach(() => vi.restoreAllMocks());

	it('shows the server total from GET /api/chat/unread', async () => {
		global.fetch = vi.fn().mockResolvedValue(unreadResponse(7));
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('7'));
		expect(global.fetch).toHaveBeenCalledWith(CHAT_UNREAD_API);
	});

	it('does not touch localStorage (read state is server-side)', async () => {
		window.localStorage.clear();
		global.fetch = vi.fn().mockResolvedValue(unreadResponse(1));
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('1'));
		expect(window.localStorage.getItem('crewly.chat.seen')).toBeNull();
	});

	it('refetches immediately when the Chat page announces a read-state change', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(unreadResponse(3)).mockResolvedValue(unreadResponse(0));
		global.fetch = fetchMock;
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('3'));
		notifyChatUnreadChanged();
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('0'));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('stays unknown when the request fails or is not ok', async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error('down'));
		render(<Probe />);
		await waitFor(() => expect(global.fetch).toHaveBeenCalled());
		expect(screen.getByTestId('n')).toHaveTextContent('null');
	});

	it('keeps the last known count when a refresh fails', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(unreadResponse(4))
			.mockResolvedValue({ ok: false } as unknown as Response);
		global.fetch = fetchMock;
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('4'));
		notifyChatUnreadChanged();
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(screen.getByTestId('n')).toHaveTextContent('4');
	});
});
