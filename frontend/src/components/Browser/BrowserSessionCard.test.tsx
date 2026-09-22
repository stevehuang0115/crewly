/**
 * BrowserSessionCard tests.
 *
 * @module components/Browser/BrowserSessionCard.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserSessionCard, hostOf } from './BrowserSessionCard';
import type { BrowserSession } from '../../services/browser-session.service';

const base: BrowserSession = {
	id: 'flopost-pia',
	agentSession: 'flopost-pia',
	agentName: 'Pia',
	status: 'reading',
	lastAction: 'Reading page',
	lastActionAt: Date.now(),
	startedAt: Date.now(),
	url: 'https://account.sunrun.com/transfer?token=secret-session-token',
	frameAt: 1234,
};

describe('hostOf', () => {
	it('keeps only the host, not the query string', () => {
		// The full URL routinely carries a session token; this label sits in a
		// list someone may screen-share.
		expect(hostOf('https://account.sunrun.com/transfer?token=abc')).toBe('account.sunrun.com');
	});

	it('returns an empty string for a missing or unparseable URL', () => {
		expect(hostOf(undefined)).toBe('');
		expect(hostOf('not a url')).toBe('');
	});
});

describe('BrowserSessionCard', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('shows the agent, its status and the host only', () => {
		render(<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} />);

		expect(screen.getByText('Pia')).toBeInTheDocument();
		expect(screen.getByText('Reading page')).toBeInTheDocument();
		expect(screen.getByText(/account\.sunrun\.com/)).toBeInTheDocument();
		expect(screen.queryByText(/secret-session-token/)).not.toBeInTheDocument();
	});

	it('falls back to the session name when the agent has no display name', () => {
		const { agentName, ...noName } = base;
		render(<BrowserSessionCard session={noName as BrowserSession} expanded={false} onToggle={() => {}} />);
		expect(screen.getByText('flopost-pia')).toBeInTheDocument();
	});

	it('does not render the picture until expanded', () => {
		const { rerender } = render(
			<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} />,
		);
		expect(screen.queryByRole('img')).not.toBeInTheDocument();

		rerender(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		expect(screen.getByRole('img')).toBeInTheDocument();
	});

	it('points the picture at the frame endpoint for this session', () => {
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		const src = screen.getByRole('img').getAttribute('src')!;
		expect(src).toContain('/api/browser/sessions/flopost-pia/frame');
		expect(src).toContain('t=1234');
	});

	it('says plainly that the picture goes nowhere else', () => {
		// The rule this whole feature is built around, stated where the person
		// looking at a screenshot of their own logged-in account can read it.
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		expect(screen.getByText(/never attached to a chat message or posted to Slack/)).toBeInTheDocument();
	});

	it('waits for a frame rather than showing a broken image', () => {
		const { frameAt, ...noFrame } = base;
		render(<BrowserSessionCard session={noFrame as BrowserSession} expanded onToggle={() => {}} />);
		expect(screen.getByText(/Waiting for the first frame/)).toBeInTheDocument();
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('surfaces a capture failure instead of silently showing a stale frame', () => {
		render(
			<BrowserSessionCard
				session={{ ...base, frameError: 'Cannot access a chrome:// URL' }}
				expanded
				onToggle={() => {}}
			/>,
		);
		expect(screen.getByText(/Cannot access a chrome:\/\/ URL/)).toBeInTheDocument();
	});

	it('re-requests the frame on a timer while expanded', () => {
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		const first = screen.getByRole('img').getAttribute('src');

		act(() => {
			vi.advanceTimersByTime(1600);
		});

		expect(screen.getByRole('img').getAttribute('src')).not.toBe(first);
	});

	it('stops polling once collapsed, so an unwatched session costs nothing', () => {
		const { rerender } = render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		rerender(<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} />);

		act(() => {
			vi.advanceTimersByTime(10_000);
		});

		// Nothing to assert on the DOM — the picture is gone; the point is that
		// advancing the clock does not throw or schedule work on a dead card.
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('toggles when the header is clicked', () => {
		const onToggle = vi.fn();
		render(<BrowserSessionCard session={base} expanded={false} onToggle={onToggle} />);

		fireEvent.click(screen.getByRole('button', { name: /Pia/ }));

		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('offers Stop for a running session and not for a finished one', () => {
		const onStop = vi.fn();
		const { rerender } = render(
			<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} onStop={onStop} />,
		);
		expect(screen.getByText('Stop')).toBeInTheDocument();

		rerender(
			<BrowserSessionCard
				session={{ ...base, status: 'done' }}
				expanded={false}
				onToggle={() => {}}
				onStop={onStop}
			/>,
		);
		expect(screen.queryByText('Stop')).not.toBeInTheDocument();
	});

	it('stops without also toggling the card open', () => {
		const onStop = vi.fn();
		const onToggle = vi.fn();
		render(<BrowserSessionCard session={base} expanded={false} onToggle={onToggle} onStop={onStop} />);

		fireEvent.click(screen.getByText('Stop'));

		expect(onStop).toHaveBeenCalledWith('flopost-pia');
		expect(onToggle).not.toHaveBeenCalled();
	});
});
