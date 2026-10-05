/**
 * Tests for the known input-box screens run by the release input-guard check.
 */

import { classifyWithOwnPastes } from './tui-input-guard.js';
import { FIVE_LINES, KNOWN_INPUT_SCREENS, SPLIT_BRIEF } from './input-guard-known-screens.js';

describe('KNOWN_INPUT_SCREENS', () => {
	it('names are unique and the messages have the shapes the screens claim', () => {
		const names = KNOWN_INPUT_SCREENS.map((k) => k.name);
		expect(new Set(names).size).toBe(names.length);
		expect((SPLIT_BRIEF.match(/\n/g) ?? []).length).toBe(14);
		expect((FIVE_LINES.match(/\n/g) ?? []).length).toBe(4);
	});

	it('each screen reads as expected with the current guard', () => {
		for (const k of KNOWN_INPUT_SCREENS) {
			expect({ name: k.name, state: classifyWithOwnPastes(k.view, k.message, k.stage, k.pastes).state }).toEqual({ name: k.name, state: k.expect });
		}
	});

	it('covers crewly#1028 both ways: our split paste is ours, the owner\'s is not', () => {
		const ours = KNOWN_INPUT_SCREENS.filter((k) => k.name.startsWith('own-split'));
		const owner = KNOWN_INPUT_SCREENS.find((k) => k.name === 'owner-split-paste');
		expect(ours.length).toBe(2);
		expect(ours.every((k) => k.view.lines.some((l) => l.includes('][Pasted text #')))).toBe(true);
		expect(owner?.pastes).toEqual([]);
	});
});
