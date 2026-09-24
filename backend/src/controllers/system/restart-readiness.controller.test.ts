/**
 * Tests for GET /api/system/restart-readiness.
 */

import type { Request, Response } from 'express';

const mockGetReadiness = jest.fn();
jest.mock('../../services/restart/restart-drain.service.js', () => ({
	RestartDrainService: { getInstance: () => ({ getReadiness: mockGetReadiness }) },
}));
jest.mock('../../services/core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

import { getRestartReadiness } from './restart-readiness.controller.js';

/**
 * Minimal Express response double.
 *
 * @returns Response with jest spies
 */
function makeRes(): Response & { json: jest.Mock; status: jest.Mock } {
	const res = { json: jest.fn(), status: jest.fn() } as unknown as Response & { json: jest.Mock; status: jest.Mock };
	res.status.mockReturnValue(res);
	return res;
}

describe('getRestartReadiness', () => {
	beforeEach(() => mockGetReadiness.mockReset());

	it('returns the drain service readiness', () => {
		const body = {
			safe: false,
			busyAgents: [{ session: 'ella', since: '2026-09-24T01:38:30.000Z', messagePreview: 'check my To Do' }],
			queued: 2,
			draining: false,
		};
		mockGetReadiness.mockReturnValue(body);
		const res = makeRes();
		getRestartReadiness({} as Request, res);
		expect(res.json).toHaveBeenCalledWith(body);
	});

	it('answers 500 when readiness cannot be computed', () => {
		mockGetReadiness.mockImplementation(() => {
			throw new Error('boom');
		});
		const res = makeRes();
		getRestartReadiness({} as Request, res);
		expect(res.status).toHaveBeenCalledWith(500);
		expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to compute restart readiness' });
	});
});
