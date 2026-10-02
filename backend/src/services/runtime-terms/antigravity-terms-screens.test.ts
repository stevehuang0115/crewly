/**
 * Tests for reading Antigravity CLI's first-run screens. The fixtures are
 * the real agy 1.2.14 screens (captured in a PTY), not invented text.
 */
import { isAntigravityFirstRunScreen, parseAntigravityTermsScreen } from './antigravity-terms-screens.js';

const BOX = '│ > you: add a greeting function                              │';

/** The real Terms screen, focus on the data item, box checked. */
const TERMS_REAL = `
    ▄▀▀▄
   ▀▀▀▀▀▀

Terms of Service & Data Use

AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration,
prompt injection and supply chain risks. Ensure that you monitor and verify all actions taken by the agent.

------------------------------------------------------------------------------------------------------------------------

  > [x] Yes, I agree to help improve Antigravity CLI by allowing
      Google to collect and use my Interactions data,
      subject to the Google Antigravity CLI Terms of Service
      and Google Privacy Policy. I understand I can
      choose to opt out later whenever I want via my
      settings.

      Links:
      - Terms of Service: https://antigravity.google/terms
      - Privacy Policy: https://policies.google.com/privacy

    [Previous]      [Done]


  ↑/↓ Navigate · enter Toggle
                                                                                                    Gemini 3.1 Pro · low`;

describe('parseAntigravityTermsScreen', () => {
	it('reads the Terms screen: focus on the item, box checked', () => {
		expect(parseAntigravityTermsScreen(TERMS_REAL)).toEqual({ kind: 'terms', focus: 'data', dataChecked: true });
	});

	it('reads an unchecked box and a focused button (drawn without brackets)', () => {
		const prev = TERMS_REAL.replace('  > [x] Yes', '    [ ] Yes').replace('    [Previous]      [Done]', '  >  Previous       [Done]');
		expect(parseAntigravityTermsScreen(prev)).toEqual({ kind: 'terms', focus: 'previous', dataChecked: false });
		const done = TERMS_REAL.replace('  > [x] Yes', '    [x] Yes').replace('    [Previous]      [Done]', '    [Previous]    >  Done');
		expect(parseAntigravityTermsScreen(done)).toEqual({ kind: 'terms', focus: 'done', dataChecked: true });
	});

	it('cannot read the box when the item wording changed', () => {
		const changed = TERMS_REAL.replace('Yes, I agree to help improve Antigravity CLI by allowing', 'Allow Google to use my data.');
		expect(parseAntigravityTermsScreen(changed)).toMatchObject({ kind: 'terms', dataChecked: null });
	});

	it('strips ANSI (the focused button is drawn in inverse video)', () => {
		const ansi = TERMS_REAL.replace('  > [x] Yes', '    [x] Yes').replace('    [Previous]      [Done]', '    \x1b[1m\x1b[34m[Previous]\x1b[0m    > \x1b[7m\x1b[32m Done \x1b[0m');
		expect(parseAntigravityTermsScreen(ansi)).toEqual({ kind: 'terms', focus: 'done', dataChecked: true });
	});

	it('reads the colour-scheme screen next to its preview box', () => {
		const screen = [
			'Welcome to Antigravity CLI!',
			'',
			'Choose your color scheme:        ╭──────╮',
			`                                 ${BOX}`,
			`  > terminal                     ${BOX}`,
			`    light                        ${BOX}`,
			`    solarized light              ${BOX}`,
			`    tokyo night                  ${BOX}`,
			'                                 ╰──────╯',
			'',
			'    [Next]',
			'',
			'  ↑/↓ Navigate · enter Confirm',
		].join('\n');
		expect(parseAntigravityTermsScreen(screen)).toEqual({
			kind: 'color_scheme',
			focus: { type: 'scheme', name: 'terminal' },
			chosenScheme: null,
			migration: false,
			importChecked: null,
		});
	});

	it('reads the migration section: chosen scheme, import box, Next focus', () => {
		const base = [
			'Choose your color scheme:        ╭──────╮',
			`  * terminal                     ${BOX}`,
			`    light                        ${BOX}`,
			'Migration options:',
			'  > [ ] Import extensions from Gemini CLI (1 found: google-workspace)',
			'',
			'    [Next]',
		].join('\n');
		expect(parseAntigravityTermsScreen(base)).toEqual({
			kind: 'color_scheme',
			focus: { type: 'import', checked: false },
			chosenScheme: 'terminal',
			migration: true,
			importChecked: false,
		});
		const next = base.replace('  > [ ] Import', '    [x] Import').replace('    [Next]', '  >  Next');
		expect(parseAntigravityTermsScreen(next)).toMatchObject({ focus: { type: 'next' }, importChecked: true });
	});

	it('tells "light" from "solarized light"', () => {
		const screen = ['Choose your color scheme:', '    terminal', '  > solarized light', '    light'].join('\n');
		expect(parseAntigravityTermsScreen(screen)).toMatchObject({ focus: { type: 'scheme', name: 'solarized light' } });
	});

	it('recognises the prompt, the folder-trust screen and an account sign-in', () => {
		expect(parseAntigravityTermsScreen('> Accept-edits mode\n? for shortcuts   accept-edits')).toEqual({ kind: 'main_prompt' });
		expect(parseAntigravityTermsScreen('Do you trust the contents of this project?\n> Yes, I trust this folder')).toEqual({ kind: 'trust' });
		expect(parseAntigravityTermsScreen(' Welcome to the Antigravity CLI. You are currently not signed in.\n Select login method:')).toEqual({ kind: 'login' });
		expect(parseAntigravityTermsScreen('$ ')).toEqual({ kind: 'unknown' });
	});

	it('isAntigravityFirstRunScreen', () => {
		expect(isAntigravityFirstRunScreen(TERMS_REAL)).toBe(true);
		expect(isAntigravityFirstRunScreen('Choose your color scheme:\n  > terminal')).toBe(true);
		expect(isAntigravityFirstRunScreen('? for shortcuts')).toBe(false);
	});
});
