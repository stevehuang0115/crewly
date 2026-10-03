/**
 * Tests for the out-of-band agent-origin correction store.
 */

import { getAgentOriginCorrection, setAgentOriginCorrection } from './agent-origin-correction.js';

describe('agent origin correction', () => {
	it('is kept per request object', () => {
		const a = {};
		const b = {};
		setAgentOriginCorrection(a, { claimed: 'crewly-orc', actual: 'crewly-dev-sam' });
		expect(getAgentOriginCorrection(a)).toEqual({ claimed: 'crewly-orc', actual: 'crewly-dev-sam' });
		expect(getAgentOriginCorrection(b)).toBeUndefined();
	});

	it('cannot be set through a header', () => {
		const req = { headers: { 'x-agent-session-claimed': 'crewly-orc' } };
		expect(getAgentOriginCorrection(req)).toBeUndefined();
	});
});
