/**
 * Tests for recognising Crewly's own Slack bots (issue #968).
 */

import { isCrewlyBotUserId } from './slack-bot-ids.js';

describe('isCrewlyBotUserId', () => {
	const sources = {
		findAgentByBotUserId: (id: string) => (id === 'UBOTDEV1' ? 'dev-1' : null),
		cloudBotUserIds: () => ['UMASTER1', 'UBOTFAR1'],
		masterBotUserId: () => 'UMASTER2',
	};

	it('knows agent bots, Cloud-config bots and the master bot', () => {
		expect(isCrewlyBotUserId('UBOTDEV1', sources)).toBe(true);
		expect(isCrewlyBotUserId('UBOTFAR1', sources)).toBe(true);
		expect(isCrewlyBotUserId('UMASTER2', sources)).toBe(true);
	});

	it('a person is not a bot; nothing known means not a bot', () => {
		expect(isCrewlyBotUserId('UINFO001', sources)).toBe(false);
		expect(isCrewlyBotUserId('', sources)).toBe(false);
		expect(isCrewlyBotUserId('UINFO001', {})).toBe(false);
	});

	it('a failing source does not decide', () => {
		const broken = {
			findAgentByBotUserId: () => {
				throw new Error('store not loaded');
			},
			cloudBotUserIds: () => ['UMASTER1'],
		};
		expect(isCrewlyBotUserId('UMASTER1', broken)).toBe(true);
		expect(isCrewlyBotUserId('UINFO001', broken)).toBe(false);
	});

	it('works with the backend sources before Slack is up', () => {
		expect(isCrewlyBotUserId('UINFO001')).toBe(false);
	});
});
