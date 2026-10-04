/**
 * Tests for credential-guard alerts (specs/2026-10-04-agent-credential-isolation.md, layer 4).
 */

import { CredentialGuardAlertService } from './credential-guard-alerts.js';

describe('CredentialGuardAlertService', () => {
	let now = 0;
	const DAY = 24 * 60 * 60 * 1000;

	it('tells the owner once per agent per day, counting the attempts in between', () => {
		const notifier = jest.fn().mockResolvedValue(true);
		const svc = new CredentialGuardAlertService(() => now);
		svc.setOwnerNotifier(notifier);

		expect(svc.record({ sessionName: 'ruth', rule: 'cloud-config', runtime: 'antigravity' })).toEqual({ notified: true });
		expect(svc.record({ sessionName: 'ruth', rule: 'api-token' })).toEqual({ notified: false });
		expect(svc.record({ sessionName: 'ella', rule: 'api-token' })).toEqual({ notified: true });
		now += DAY - 1;
		expect(svc.record({ sessionName: 'ruth', rule: 'cloud-config' })).toEqual({ notified: false });
		now += 1;
		expect(svc.record({ sessionName: 'ruth', rule: 'cloud-config' })).toEqual({ notified: true });

		expect(notifier).toHaveBeenCalledTimes(3);
		expect(notifier.mock.calls[0][0].message).toMatch(/ruth tried to read Crewly's own credentials \(cloud-config\)/);
		expect(notifier.mock.calls[2][0].message).toMatch(/\(3 attempts\)/);
	});

	it('does not use up the day when nobody can be told (Slack not connected)', () => {
		now = 0;
		const svc = new CredentialGuardAlertService(() => now);
		expect(svc.record({ sessionName: 'ruth', rule: 'api-token' })).toEqual({ notified: false });
		const notifier = jest.fn().mockResolvedValue(true);
		svc.setOwnerNotifier(notifier);
		expect(svc.record({ sessionName: 'ruth', rule: 'api-token' })).toEqual({ notified: true });
	});

	it('survives a failing notifier', async () => {
		const svc = new CredentialGuardAlertService(() => 0);
		svc.setOwnerNotifier(jest.fn().mockRejectedValue(new Error('slack down')));
		expect(svc.record({ sessionName: 'x', rule: 'api-token' })).toEqual({ notified: true });
		await new Promise((r) => setImmediate(r));
	});
});
