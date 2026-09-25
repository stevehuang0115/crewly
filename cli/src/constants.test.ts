/**
 * Tests for the CLI constants.
 */

import { CLI_CONSTANTS, DEFAULT_WEB_PORT } from './constants.js';

describe('CLI_CONSTANTS', () => {
	it('keeps the standard exit codes', () => {
		expect(CLI_CONSTANTS.EXIT_CODES).toEqual({ SUCCESS: 0, ERROR: 1, INVALID_ARGS: 2 });
	});

	it('polls harness logins every second and hands off after 30 s', () => {
		expect(CLI_CONSTANTS.HARNESS_SETUP.POLL_INTERVAL_MS).toBe(1000);
		expect(CLI_CONSTANTS.HARNESS_SETUP.URL_WAIT_MS).toBe(30_000);
		expect(CLI_CONSTANTS.HARNESS_SETUP.SCREEN_FALLBACK_MS).toBeLessThan(CLI_CONSTANTS.HARNESS_SETUP.URL_WAIT_MS);
	});

	it('waits about a minute for a freshly started backend before opening the setup page', () => {
		expect(CLI_CONSTANTS.ONBOARD.WEB_WAIT_ATTEMPTS * CLI_CONSTANTS.ONBOARD.WEB_WAIT_INTERVAL_MS).toBe(60_000);
	});

	it('runs seven wizard steps and talks to the checklist routes', () => {
		expect(CLI_CONSTANTS.ONBOARD.TOTAL_STEPS).toBe(7);
		expect(CLI_CONSTANTS.ONBOARD.CHECKLIST_ENDPOINT).toBe('/api/onboarding/checklist');
		expect(CLI_CONSTANTS.ONBOARD.FIRST_TASK_ENDPOINT).toBe('/api/onboarding/first-task');
	});

	it('exposes the default web port', () => {
		expect(DEFAULT_WEB_PORT).toBeGreaterThan(0);
	});
});
