import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExecutionFeed } from './ExecutionFeed';

// ---- Mock WebSocket service ----
const listeners = new Map<string, Set<(data: any) => void>>();

vi.mock('../../services/websocket.service', () => ({
	webSocketService: {
		on: vi.fn((event: string, cb: (data: any) => void) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(cb);
		}),
		off: vi.fn((event: string, cb: (data: any) => void) => {
			listeners.get(event)?.delete(cb);
		}),
	},
}));

/** Simulate a WebSocket event. */
function emitWsEvent(event: string, payload: any) {
	listeners.get(event)?.forEach((cb) => cb(payload));
}

describe('ExecutionFeed', () => {
	beforeEach(() => {
		listeners.clear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		listeners.clear();
	});

	it('renders empty state when no events', () => {
		render(<ExecutionFeed />);
		expect(screen.getByTestId('execution-feed')).toBeInTheDocument();
		expect(screen.getByText(/waiting for live events/i)).toBeInTheDocument();
	});

	it('renders header with title', () => {
		render(<ExecutionFeed />);
		expect(screen.getByText('Execution Feed')).toBeInTheDocument();
	});

	it('displays agent status event from WebSocket', () => {
		render(<ExecutionFeed />);

		act(() => {
			emitWsEvent('team_member_status_changed', {
				name: 'Sam',
				sessionName: 'crewly-product-sam',
				agentStatus: 'active',
				role: 'developer',
			});
		});

		expect(screen.getByText('Sam is now active')).toBeInTheDocument();
		expect(screen.getByText('Role: developer')).toBeInTheDocument();
	});

	it('displays orchestrator status event', () => {
		render(<ExecutionFeed />);

		act(() => {
			emitWsEvent('orchestrator_status_changed', {
				agentStatus: 'active',
			});
		});

		expect(screen.getByText('Orchestrator is now active')).toBeInTheDocument();
	});

	it('displays queue events', () => {
		render(<ExecutionFeed />);

		act(() => {
			emitWsEvent('queue:message_completed', {
				sessionName: 'crewly-product-sam',
				snippet: 'Task X finished successfully',
			});
		});

		expect(screen.getByText('Message message completed')).toBeInTheDocument();
	});

	it('displays team_activity_updated events with tasks', () => {
		render(<ExecutionFeed />);

		act(() => {
			emitWsEvent('team_activity_updated', {
				members: [
					{
						name: 'Leo',
						agentStatus: 'active',
						currentTask: 'Implementing F15',
					},
				],
			});
		});

		expect(screen.getByText('Working on: Implementing F15')).toBeInTheDocument();
	});

	it('shows event count in header', () => {
		render(<ExecutionFeed />);

		act(() => {
			emitWsEvent('team_member_status_changed', {
				name: 'Agent1',
				agentStatus: 'active',
			});
			emitWsEvent('team_member_status_changed', {
				name: 'Agent2',
				agentStatus: 'idle',
			});
		});

		expect(screen.getByText('(2)')).toBeInTheDocument();
	});

	it('shows Clear button when events exist and clears on click', async () => {
		const user = userEvent.setup();
		render(<ExecutionFeed />);

		// No clear button initially
		expect(screen.queryByTestId('feed-clear')).not.toBeInTheDocument();

		act(() => {
			emitWsEvent('team_member_status_changed', {
				name: 'Sam',
				agentStatus: 'active',
			});
		});

		const clearBtn = screen.getByTestId('feed-clear');
		expect(clearBtn).toBeInTheDocument();

		await user.click(clearBtn);
		expect(screen.getByText(/waiting for live events/i)).toBeInTheDocument();
	});

	it('respects maxEvents limit', () => {
		render(<ExecutionFeed maxEvents={3} />);

		act(() => {
			for (let i = 0; i < 5; i++) {
				emitWsEvent('team_member_status_changed', {
					name: `Agent${i}`,
					agentStatus: 'active',
				});
			}
		});

		const entries = screen.getAllByTestId('feed-entry');
		expect(entries).toHaveLength(3);
	});

	it('shows newest events first', () => {
		render(<ExecutionFeed />);

		act(() => {
			emitWsEvent('team_member_status_changed', {
				name: 'First',
				agentStatus: 'active',
			});
			emitWsEvent('team_member_status_changed', {
				name: 'Second',
				agentStatus: 'idle',
			});
		});

		const entries = screen.getAllByTestId('feed-entry');
		expect(entries[0]).toHaveTextContent('Second is now idle');
		expect(entries[1]).toHaveTextContent('First is now active');
	});

	it('applies custom className', () => {
		render(<ExecutionFeed className="h-96" />);
		const feed = screen.getByTestId('execution-feed');
		expect(feed.className).toContain('h-96');
	});

	it('cleans up WebSocket listeners on unmount', async () => {
		const { unmount } = render(<ExecutionFeed />);
		const mod = await import('../../services/websocket.service');
		const ws = vi.mocked(mod.webSocketService);

		unmount();

		// off should be called for all registered events
		expect(ws.off).toHaveBeenCalled();
	});
});
