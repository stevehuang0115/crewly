import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWaitingOnYouCount } from './useWaitingOnYouCount';

vi.mock('../services/decisions.service', () => ({
	listOpenDecisions: vi.fn(),
}));
import { listOpenDecisions } from '../services/decisions.service';

const Probe: React.FC = () => {
	const n = useWaitingOnYouCount();
	return <div data-testid="n">{n === null ? 'null' : String(n)}</div>;
};

describe('useWaitingOnYouCount', () => {
	it('counts open decisions', async () => {
		vi.mocked(listOpenDecisions).mockResolvedValue([{ id: 'D-1' }, { id: 'D-2' }] as never);
		render(<Probe />);
		await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('2'));
	});

	it('stays unknown when the request fails', async () => {
		vi.mocked(listOpenDecisions).mockRejectedValue(new Error('down'));
		render(<Probe />);
		await waitFor(() => expect(listOpenDecisions).toHaveBeenCalled());
		expect(screen.getByTestId('n')).toHaveTextContent('null');
	});
});
