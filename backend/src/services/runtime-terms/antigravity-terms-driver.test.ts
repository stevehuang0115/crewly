/**
 * Tests for driving Antigravity CLI's first-run screens against the fake
 * TUI (same screens, same key behaviour as agy 1.2.14). Each test checks
 * the keys the TUI received and the state Done accepted.
 */
import { driveAntigravityTerms, nextTermsStep, type TermsDriveOptions } from './antigravity-terms-driver.js';
import { FakeAgyTui } from './fake-agy-tui.fixture.js';

/** Virtual clock: sleeping advances time, so timeouts are exact and instant. */
function clockOpts(shareData: boolean, over: Partial<TermsDriveOptions> = {}): TermsDriveOptions {
	let t = 0;
	return { shareData, now: () => t, sleep: async (ms) => void (t += ms), ...over };
}

describe('driveAntigravityTerms', () => {
	it('"Agree, no data sharing": terminal scheme, unchecks the data box, verifies, Done', async () => {
		const tui = new FakeAgyTui();
		const result = await driveAntigravityTerms(tui, clockOpts(false));
		expect(result).toMatchObject({ ok: true, donePressed: true, alreadyAccepted: false, dataSharing: false });
		expect(tui.accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: false });
		expect(tui.doneCount).toBe(1);
		// Enter (scheme), Enter (toggle off), Down (to Previous), Right (to Done), Enter (Done)
		expect(tui.keys).toEqual(['Enter', 'Enter', 'Down', 'Right', 'Enter']);
		expect(tui.screenName).toBe('main');
	});

	it('"Agree + share data": leaves the pre-checked box alone', async () => {
		const tui = new FakeAgyTui();
		const result = await driveAntigravityTerms(tui, clockOpts(true));
		expect(result).toMatchObject({ ok: true, donePressed: true, dataSharing: true });
		expect(tui.accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: true });
		expect(tui.keys).toEqual(['Enter', 'Down', 'Right', 'Enter']);
	});

	it('handles the migration screen: no import, then Next', async () => {
		const tui = new FakeAgyTui({ migration: true });
		const result = await driveAntigravityTerms(tui, clockOpts(false));
		expect(result.ok).toBe(true);
		expect(tui.accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: false });
		expect(tui.keys).toEqual(['Enter', 'Down', 'Enter', 'Enter', 'Down', 'Right', 'Enter']);
	});

	it('moves the focus back to the default scheme by reading the screen', async () => {
		const tui = new FakeAgyTui({ migration: true, startScheme: 'tokyo night' });
		const result = await driveAntigravityTerms(tui, clockOpts(true));
		expect(result.ok).toBe(true);
		expect(tui.accepted).toEqual({ scheme: 'terminal', importExtensions: false, dataSharing: true });
		expect(tui.keys.slice(0, 7)).toEqual(['Up', 'Up', 'Up', 'Up', 'Up', 'Up', 'Up']);
	});

	it('already accepted: the prompt shows at once, nothing is pressed', async () => {
		const tui = new FakeAgyTui({ alreadyAccepted: true });
		const result = await driveAntigravityTerms(tui, clockOpts(false));
		expect(result).toMatchObject({ ok: true, donePressed: false, alreadyAccepted: true });
		expect(tui.keys).toEqual([]);
	});

	it('a Terms screen it cannot read aborts and never presses Done', async () => {
		const tui = new FakeAgyTui({ changedTerms: true });
		const result = await driveAntigravityTerms(tui, clockOpts(false));
		expect(result.ok).toBe(false);
		expect(result.donePressed).toBe(false);
		expect(result.error).toMatch(/data-sharing checkbox/);
		expect(tui.doneCount).toBe(0);
		expect(tui.accepted).toBeNull();
		expect(result.screen).toContain('Terms of Service & Data Use');
	});

	it('a checkbox that does not toggle aborts after the key budget, never Done', async () => {
		const tui = new FakeAgyTui({ stuckCheckbox: true });
		const result = await driveAntigravityTerms(tui, clockOpts(false, { maxKeys: 10 }));
		expect(result.ok).toBe(false);
		expect(tui.doneCount).toBe(0);
		expect(result.error).toMatch(/Gave up after 10 keys/);
	});

	it('an account sign-in aborts at once', async () => {
		const tui = new FakeAgyTui({ accountLogin: true });
		const result = await driveAntigravityTerms(tui, clockOpts(false));
		expect(result).toMatchObject({ ok: false, donePressed: false });
		expect(result.error).toMatch(/Google account sign-in/);
		expect(tui.keys).toEqual([]);
	});

	it('an unknown screen times out without a key', async () => {
		const tui = { write: jest.fn(), capture: () => 'Something else entirely' };
		const result = await driveAntigravityTerms(tui, clockOpts(false, { launchTimeoutMs: 5_000 }));
		expect(result).toMatchObject({ ok: false, donePressed: false });
		expect(result.error).toMatch(/did not show its setup screens/);
		expect(tui.write).not.toHaveBeenCalled();
	});

	it('refuses Done when the screen changes between the check and the key', async () => {
		const tui = new FakeAgyTui();
		let doneReads = 0;
		const flaky = {
			write: (d: string) => tui.write(d),
			capture: () => {
				const s = tui.capture();
				if (tui.termsFocus !== 'done') return s;
				doneReads += 1;
				// Reads on Done: 1 = after the key, 2 = the decision, 3 = the
				// re-check right before Enter — that one shows the box flipped back.
				return doneReads === 3 ? s.replace('[ ] Yes', '[x] Yes') : s;
			},
		};
		const result = await driveAntigravityTerms(flaky, clockOpts(false));
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/changed just before Done/);
		expect(tui.doneCount).toBe(0);
	});

	it('Done pressed but no prompt: reported as such', async () => {
		const tui = new FakeAgyTui();
		const stuck = {
			write: (d: string) => tui.write(d),
			capture: () => (tui.screenName === 'main' ? 'loading…' : tui.capture()),
		};
		const result = await driveAntigravityTerms(stuck, clockOpts(false, { promptTimeoutMs: 1_000 }));
		expect(result).toMatchObject({ ok: false, donePressed: true, dataSharing: false });
		expect(result.error).toMatch(/did not show its prompt/);
	});
});

describe('nextTermsStep', () => {
	it('never chooses Enter on Done while the box differs from the choice', () => {
		expect(nextTermsStep({ kind: 'terms', focus: 'done', dataChecked: true }, false, false)).toEqual({ key: 'Left' });
		expect(nextTermsStep({ kind: 'terms', focus: 'done', dataChecked: false }, false, false)).toEqual({ key: 'Enter' });
		expect(nextTermsStep({ kind: 'terms', focus: 'data', dataChecked: null }, true, false)).toHaveProperty('abort');
	});

	it('colour screen after Done is a mismatch', () => {
		expect(nextTermsStep({ kind: 'color_scheme', focus: null, chosenScheme: null, migration: false, importChecked: null }, true, true)).toHaveProperty('abort');
	});
});
