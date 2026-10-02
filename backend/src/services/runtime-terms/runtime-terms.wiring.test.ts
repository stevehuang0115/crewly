/**
 * Tests for the Antigravity Terms profile and its wiring.
 */
import { DecisionService } from '../decisions/decision.service.js';
import { getRuntimeTermsConsentService, setRuntimeTermsConsentService } from './runtime-terms-consent.service.js';
import { ANTIGRAVITY_TERMS_PROFILE, antigravityTermsCard, startRuntimeTerms, termsSessionName } from './runtime-terms.wiring.js';
import { FakeAgyTui } from './fake-agy-tui.fixture.js';

describe('antigravityTermsCard', () => {
	const card = antigravityTermsCard('steve-mbp');

	it('names the runtime and the machine, and fits Slack limits', () => {
		expect(card.title).toBe('Antigravity CLI · Terms of Service (steve-mbp)');
		expect(card.title.length).toBeLessThanOrEqual(150);
		expect(card.question.length).toBeLessThanOrEqual(280);
		expect(card.question).toContain('steve-mbp');
	});

	it('summarises, links, and shows the pre-checked data item separately', () => {
		expect(card.body[0]).toMatch(/Terms of Service and the Google Privacy Policy/);
		expect(card.body[1]).toContain('<https://antigravity.google/terms|Terms of Service>');
		expect(card.body[1]).toContain('<https://policies.google.com/privacy|Privacy Policy>');
		expect(card.body[2]).toMatch(/^\*A separate item, pre-checked on the screen:\*/);
		expect(card.body[2]).toContain('allowing Google to collect and use my Interactions data');
		for (const text of [card.title, card.question, ...card.body]) expect(text).not.toMatch(/[㐀-鿿]/);
		for (const text of card.body) expect(text.length).toBeLessThanOrEqual(3000);
	});
});

describe('ANTIGRAVITY_TERMS_PROFILE', () => {
	it('drives through the real driver', async () => {
		const tui = new FakeAgyTui({ alreadyAccepted: true });
		const result = await ANTIGRAVITY_TERMS_PROFILE.drive(tui, false);
		expect(result).toMatchObject({ ok: true, alreadyAccepted: true });
	});

	it('classifies screens for a probe', () => {
		expect(ANTIGRAVITY_TERMS_PROFILE.classify('Terms of Service & Data Use\n  > [x] Yes, I agree to help improve Antigravity CLI by')).toBe('terms');
		expect(ANTIGRAVITY_TERMS_PROFILE.classify('Choose your color scheme:\n  > terminal')).toBe('terms');
		expect(ANTIGRAVITY_TERMS_PROFILE.classify('? for shortcuts')).toBe('ready');
		expect(ANTIGRAVITY_TERMS_PROFILE.classify('Select login method:')).toBe('blocked');
		expect(ANTIGRAVITY_TERMS_PROFILE.classify('$ ')).toBe('unknown');
		expect(ANTIGRAVITY_TERMS_PROFILE.info.links.map((l) => l.url)).toEqual(['https://antigravity.google/terms', 'https://policies.google.com/privacy']);
	});

	it('session name', () => {
		expect(termsSessionName('antigravity-cli')).toBe('crewly-terms-antigravity-cli');
	});
});

describe('startRuntimeTerms', () => {
	afterEach(() => {
		setRuntimeTermsConsentService(null);
		DecisionService.registerKindHandler('runtime_terms', null);
		jest.restoreAllMocks();
	});

	it('installs the service as the runtime_terms decision-kind handler', () => {
		const register = jest.spyOn(DecisionService, 'registerKindHandler');
		const decisions = {} as unknown as DecisionService;
		const service = startRuntimeTerms({ crewlyHome: '/tmp/crewly-terms-wiring-test', decisions, machineName: () => 'm' });
		expect(getRuntimeTermsConsentService()).toBe(service);
		expect(register).toHaveBeenCalledWith('runtime_terms', service);
		expect(service.supports('antigravity-cli')).toBe(true);
		expect(service.supports('claude-code')).toBe(false);
	});
});
