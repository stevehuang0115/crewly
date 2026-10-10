import { handedOffSince } from './follow-through.wiring.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));

const SINCE = Date.parse('2026-10-10T19:12:00Z');
const wi = (over: Partial<WorkItem>): WorkItem => ({ id: 'w', createdAt: '2026-10-10T19:13:00Z', status: 'queued', ...over }) as WorkItem;

describe('handedOffSince', () => {
	it('a WorkItem for the agent itself or one it delegated, created after the statement, covers it', () => {
		expect(handedOffSince([wi({ target: 'pia' })], 'pia', SINCE)).toBe(true);
		expect(handedOffSince([wi({ target: 'luna', metadata: { delegatedBy: 'pia' } })], 'pia', SINCE)).toBe(true);
		expect(handedOffSince([wi({ target: 'luna', metadata: { createdBy: 'pia' } })], 'pia', SINCE)).toBe(true);
	});

	it('older items, other agents\' work and unrelated items do not', () => {
		expect(handedOffSince([wi({ target: 'pia', createdAt: '2026-10-10T18:00:00Z' })], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([wi({ target: 'luna', metadata: { delegatedBy: 'ella' } })], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([], 'pia', SINCE)).toBe(false);
	});
});
