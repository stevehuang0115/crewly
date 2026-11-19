/**
 * Tests for the start-up block registry.
 */

import {
	clearStartupBlock,
	describeStartupBlock,
	listStartupBlocks,
	recordStartupBlock,
	resetStartupBlocksForTesting,
	startupBlockOf,
} from './startup-block.registry.js';

describe('start-up block registry', () => {
	afterEach(() => resetStartupBlocksForTesting());

	it('remembers a blocked start until it is cleared', () => {
		expect(startupBlockOf('crewly-orc')).toBeNull();
		recordStartupBlock('crewly-orc', 'consent_required', 'Accept Bypass Permissions mode.');
		const block = startupBlockOf('crewly-orc');
		expect(block).toMatchObject({ sessionName: 'crewly-orc', reason: 'consent_required', message: 'Accept Bypass Permissions mode.' });
		expect(Number.isNaN(Date.parse(block!.at))).toBe(false);
		expect(startupBlockOf('dev-1')).toBeNull();

		expect(clearStartupBlock('crewly-orc')).toBe(true);
		expect(startupBlockOf('crewly-orc')).toBeNull();
		expect(clearStartupBlock('crewly-orc')).toBe(false);
	});

	it('keeps the latest block per session and lists them all', () => {
		recordStartupBlock('crewly-orc', 'consent_required', 'first');
		recordStartupBlock('crewly-orc', 'unanswered_prompt', 'second');
		recordStartupBlock('dev-1', 'auth_required', 'sign in');
		expect(startupBlockOf('crewly-orc')?.reason).toBe('unanswered_prompt');
		expect(listStartupBlocks().map((b) => b.sessionName)).toEqual(['crewly-orc', 'dev-1']);
	});

	it('stores a missing reason as unknown and ignores an empty session name', () => {
		expect(recordStartupBlock('dev-1', undefined, 'blocked').reason).toBe('unknown');
		recordStartupBlock('', 'consent_required', 'blocked');
		expect(listStartupBlocks()).toHaveLength(1);
	});

	it('describes the block in one line', () => {
		const block = recordStartupBlock('crewly-orc', 'consent_required', 'Accept Bypass Permissions mode.');
		expect(describeStartupBlock('Orchestrator', block)).toBe('Orchestrator start-up is waiting on you: Accept Bypass Permissions mode.');
	});
});

describe('automaticStartBlockOf', () => {
	const { automaticStartBlockOf, recordStartupBlock, resetStartupBlocksForTesting, startupBlockOf } = jest.requireActual('./startup-block.registry.js') as typeof import('./startup-block.registry.js');

	beforeEach(() => resetStartupBlocksForTesting());

	it('holds automatic starts back while the block is fresh, and lets one through after an hour', () => {
		const block = recordStartupBlock('crewly-orc', 'unanswered_prompt', 'A menu is waiting.');
		const at = Date.parse(block.at);
		expect(automaticStartBlockOf('crewly-orc', at + 1_000)).toEqual(block);
		expect(automaticStartBlockOf('crewly-orc', at + 59 * 60 * 1000)).toEqual(block);
		expect(automaticStartBlockOf('crewly-orc', at + 60 * 60 * 1000)).toBeNull();
		// Status still shows it until a start succeeds or someone acts.
		expect(startupBlockOf('crewly-orc')).toEqual(block);
	});

	it('is null for a session that is not blocked', () => {
		expect(automaticStartBlockOf('ella-1')).toBeNull();
	});
});
