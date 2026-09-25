/**
 * Tests for the onboarding state store (`<crewlyHome>/onboarding.json`).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { EMPTY_ONBOARDING_STATE, OnboardingStateStore, normalizeOnboardingState } from './onboarding-state.store.js';

describe('normalizeOnboardingState', () => {
	it('reads garbage as empty', () => {
		expect(normalizeOnboardingState(null)).toEqual(EMPTY_ONBOARDING_STATE);
		expect(normalizeOnboardingState('x')).toEqual(EMPTY_ONBOARDING_STATE);
	});

	it('keeps well-formed fields and drops malformed ones', () => {
		expect(
			normalizeOnboardingState({
				dismissedAt: '2026-09-25T00:00:00.000Z',
				blankChosenAt: 42,
				firstTask: { sentAt: '2026-09-25T01:00:00.000Z', teamId: 't1', conversationId: 'c1' },
				pendingFirstTask: { text: '', createdAt: 'x' },
				extra: true,
			}),
		).toEqual({
			dismissedAt: '2026-09-25T00:00:00.000Z',
			blankChosenAt: null,
			firstTask: { sentAt: '2026-09-25T01:00:00.000Z', teamId: 't1', conversationId: 'c1' },
			pendingFirstTask: null,
		});
	});

	it('keeps a pending first task with a null team', () => {
		expect(normalizeOnboardingState({ pendingFirstTask: { text: 'Plan my week', createdAt: 'now' } }).pendingFirstTask).toEqual({
			text: 'Plan my week',
			teamId: null,
			createdAt: 'now',
		});
	});
});

describe('OnboardingStateStore', () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(path.join(tmpdir(), 'crewly-onboarding-state-'));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it('stores under the Crewly home dir', () => {
		expect(new OnboardingStateStore(home).getFilePath()).toBe(path.join(home, 'onboarding.json'));
	});

	it('reads a missing or corrupt file as empty', async () => {
		const store = new OnboardingStateStore(home);
		expect(await store.read()).toEqual(EMPTY_ONBOARDING_STATE);
		writeFileSync(store.getFilePath(), '{not json');
		expect(await store.read()).toEqual(EMPTY_ONBOARDING_STATE);
	});

	it('writes changes and leaves no temp files', async () => {
		const store = new OnboardingStateStore(home);
		const next = await store.update(() => ({ dismissedAt: '2026-09-25T00:00:00.000Z' }));
		expect(next.dismissedAt).toBe('2026-09-25T00:00:00.000Z');
		expect(JSON.parse(readFileSync(store.getFilePath(), 'utf-8')).dismissedAt).toBe('2026-09-25T00:00:00.000Z');
		expect(readdirSync(home)).toEqual(['onboarding.json']);
	});

	it('serializes concurrent updates so none is lost', async () => {
		const store = new OnboardingStateStore(home);
		await Promise.all([
			store.update(() => ({ dismissedAt: 'a' })),
			store.update(() => ({ blankChosenAt: 'b' })),
			store.update((cur) => ({ firstTask: { sentAt: `${cur.dismissedAt}-c`, teamId: null, conversationId: null } })),
		]);
		const state = await store.read();
		expect(state.dismissedAt).toBe('a');
		expect(state.blankChosenAt).toBe('b');
		expect(state.firstTask?.sentAt).toBe('a-c');
	});

	it('keeps working after a failed update', async () => {
		const store = new OnboardingStateStore(home);
		await expect(
			store.update(() => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect((await store.update(() => ({ dismissedAt: 'x' }))).dismissedAt).toBe('x');
	});
});
