/**
 * Tests for the fake agy TUI itself: it must behave like the real binary
 * (agy 1.2.14), or the driver tests prove nothing.
 */
import { parseAntigravityTermsScreen } from './antigravity-terms-screens.js';
import { FakeAgyTui } from './fake-agy-tui.fixture.js';

describe('FakeAgyTui', () => {
	it('starts on the colour list with "terminal" focused, data box pre-checked later', () => {
		const tui = new FakeAgyTui();
		expect(parseAntigravityTermsScreen(tui.capture())).toMatchObject({ kind: 'color_scheme', focus: { type: 'scheme', name: 'terminal' } });
		tui.write('\r');
		expect(parseAntigravityTermsScreen(tui.capture())).toEqual({ kind: 'terms', focus: 'data', dataChecked: true });
	});

	it('decodes key bytes and records them', () => {
		const tui = new FakeAgyTui({ migration: true });
		tui.write('\x1b[B\x1b[A\r');
		expect(tui.keys).toEqual(['Down', 'Up', 'Enter']);
		expect(parseAntigravityTermsScreen(tui.capture())).toMatchObject({ focus: { type: 'import', checked: false }, chosenScheme: 'terminal' });
	});

	it('↑ from the import item jumps to the bottom of the list and un-chooses (as the real one does)', () => {
		const tui = new FakeAgyTui({ migration: true });
		tui.write('\r\x1b[A');
		expect(parseAntigravityTermsScreen(tui.capture())).toMatchObject({ focus: { type: 'scheme', name: 'tokyo night' }, chosenScheme: null });
	});

	it('Terms: toggles, moves between the buttons, Previous goes back, Done accepts', () => {
		const tui = new FakeAgyTui();
		tui.write('\r');
		tui.write(' ');
		expect(tui.dataChecked).toBe(false);
		tui.write('\x1b[B');
		expect(parseAntigravityTermsScreen(tui.capture())).toMatchObject({ focus: 'previous' });
		tui.write('\r');
		expect(tui.screenName).toBe('color');
		tui.write('\r\x1b[B\x1b[C');
		expect(parseAntigravityTermsScreen(tui.capture())).toMatchObject({ focus: 'done', dataChecked: false });
		tui.write('\r');
		expect(tui.accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: false });
		expect(parseAntigravityTermsScreen(tui.capture())).toEqual({ kind: 'main_prompt' });
	});
});
