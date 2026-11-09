/**
 * Tests for stripOwnerTextIds (crewly#1427). Fixtures are real owner-thread
 * posts from the 2026-10-22 audit.
 */

import { stripOwnerTextIds } from './owner-text-ids.utils.js';

describe('stripOwnerTextIds', () => {
	it('drops a bracket that holds only ids', () => {
		expect(stripOwnerTextIds('这一项已随另一张卡(D-897)一起上线,不用再操作。')).toBe('这一项已随另一张卡一起上线,不用再操作。');
		expect(stripOwnerTextIds('给 Anthropic 的客服文字（D-851），请先别发')).toBe('给 Anthropic 的客服文字，请先别发');
		expect(stripOwnerTextIds('Approved (D-829 / TKT-537), so it ships.')).toBe('Approved, so it ships.');
	});

	it('keeps the card noun and drops its id', () => {
		expect(stripOwnerTextIds('证据台这张卡已经上线(决策卡 D-919 批准后 Dex 发布)')).toBe('证据台这张卡已经上线(决策卡批准后 Dex 发布)');
		expect(stripOwnerTextIds('并给你单独发了一张发布卡 D-900;你点发布他就上线。')).toBe('并给你单独发了一张发布卡;你点发布他就上线。');
		expect(stripOwnerTextIds('I answered on card D-7 already.')).toBe('I answered on card already.');
	});

	it('replaces any other id with "that card" in the text\'s language', () => {
		expect(stripOwnerTextIds('好,和 D-832 是同一件事,已经在做')).toBe('好,和那张卡是同一件事,已经在做');
		expect(stripOwnerTextIds('It shipped with D-897 this morning.')).toBe('It shipped with that card this morning.');
	});

	it('leaves posts to agents, code spans, links and look-alikes alone', () => {
		const toAgent = '@Sam D-848 answered: "Yes, release it". Go ahead.';
		expect(stripOwnerTextIds(toAgent)).toBe(toAgent);
		expect(stripOwnerTextIds('Run `ask-owner --status D-7` or open https://x.test/D-7')).toBe('Run `ask-owner --status D-7` or open https://x.test/D-7');
		expect(stripOwnerTextIds('ISO-8601 dates, COVID-19, CD-12 and MD-5 stay.')).toBe('ISO-8601 dates, COVID-19, CD-12 and MD-5 stay.');
		expect(stripOwnerTextIds('')).toBe('');
	});
});
