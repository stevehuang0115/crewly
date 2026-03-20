import { createScheduledMessagesLoader, ScheduledCheckInfo, ScheduledChecksProvider } from './scheduled-messages.loader.js';
import { ContextLoaderConfig } from './context-assembly.service.js';

describe('ScheduledMessagesLoader', () => {
	const baseContext: ContextLoaderConfig = {
		agentId: 'crewly-product-sam-217bfbbf',
		role: 'developer',
		projectPath: '/Users/user/projects/crewly',
		teamId: '817a1aeb',
	};

	const makeCheck = (overrides: Partial<ScheduledCheckInfo> = {}): ScheduledCheckInfo => ({
		id: 'check-001',
		targetSession: 'crewly-product-sam-217bfbbf',
		message: 'Check deployment status',
		scheduledFor: '2026-03-19T14:30:00.000Z',
		isRecurring: false,
		...overrides,
	});

	it('should return empty string when no checks exist', async () => {
		const provider: ScheduledChecksProvider = () => [];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toBe('');
	});

	it('should format recurring checks in a table', async () => {
		const provider: ScheduledChecksProvider = () => [
			makeCheck({
				id: 'rec-001',
				isRecurring: true,
				intervalMinutes: 30,
				label: 'Deploy Monitor',
				message: 'Check if deploy succeeded',
			}),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('## Scheduled Messages');
		expect(result).toContain('### Recurring Checks');
		expect(result).toContain('Deploy Monitor');
		expect(result).toContain('30m');
		expect(result).toContain('Check if deploy succeeded');
	});

	it('should format one-time checks in a table', async () => {
		const provider: ScheduledChecksProvider = () => [
			makeCheck({
				id: 'one-001',
				isRecurring: false,
				label: 'Reminder',
				message: 'Follow up on PR review',
			}),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('### One-Time Checks');
		expect(result).toContain('Reminder');
		expect(result).toContain('Follow up on PR review');
	});

	it('should separate recurring and one-time checks', async () => {
		const provider: ScheduledChecksProvider = () => [
			makeCheck({ id: 'rec-001', isRecurring: true, intervalMinutes: 10, label: 'Heartbeat' }),
			makeCheck({ id: 'one-001', isRecurring: false, label: 'Reminder' }),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('### Recurring Checks');
		expect(result).toContain('### One-Time Checks');
		expect(result).toContain('1 recurring, 1 one-time');
	});

	it('should show total count summary', async () => {
		const provider: ScheduledChecksProvider = () => [
			makeCheck({ id: 'rec-1', isRecurring: true, intervalMinutes: 5 }),
			makeCheck({ id: 'rec-2', isRecurring: true, intervalMinutes: 15 }),
			makeCheck({ id: 'one-1', isRecurring: false }),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('Total: 3 scheduled (2 recurring, 1 one-time)');
	});

	it('should truncate long messages', async () => {
		const longMessage = 'A'.repeat(100);
		const provider: ScheduledChecksProvider = () => [
			makeCheck({ message: longMessage }),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('...');
		expect(result).not.toContain(longMessage);
	});

	it('should use check ID as fallback label', async () => {
		const provider: ScheduledChecksProvider = () => [
			makeCheck({ id: 'check-fallback-label', label: undefined }),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('check-fallback-label');
	});

	it('should handle N/A interval for recurring checks without intervalMinutes', async () => {
		const provider: ScheduledChecksProvider = () => [
			makeCheck({ isRecurring: true, intervalMinutes: undefined }),
		];
		const loader = createScheduledMessagesLoader(provider);

		const result = await loader(baseContext);

		expect(result).toContain('N/A');
	});

	it('should pass agentId from context config to provider', async () => {
		let capturedAgentId = '';
		const provider: ScheduledChecksProvider = (agentId) => {
			capturedAgentId = agentId;
			return [];
		};
		const loader = createScheduledMessagesLoader(provider);

		await loader(baseContext);

		expect(capturedAgentId).toBe('crewly-product-sam-217bfbbf');
	});
});
