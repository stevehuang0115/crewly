/**
 * Tests for RegistrationFlowRegistry: one live kickoff flow per session,
 * bound to the PTY it was started for.
 */

import { RegistrationFlowRegistry } from './registration-flow-registry.js';

describe('RegistrationFlowRegistry', () => {
	const ptyA = { id: 'pty-a' };
	const ptyB = { id: 'pty-b' };

	it('lets a fresh flow write while its PTY is still the live one', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const { flow, superseded } = registry.begin('agent-1', ptyA);
		expect(superseded).toBe(false);
		expect(registry.has('agent-1')).toBe(true);
		expect(registry.isCancelled(flow.signal, ptyA)).toBe(false);
	});

	it('cancels the old flow when the session PTY is replaced (kill + recreate)', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const { flow } = registry.begin('agent-1', ptyA);
		expect(registry.isCancelled(flow.signal, ptyB)).toBe(true);
		expect(flow.signal.aborted).toBe(true);
		expect(flow.signal.reason).toBe('session-replaced');
		expect(registry.has('agent-1')).toBe(false);
	});

	it('cancels the old flow when the session is gone', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const { flow } = registry.begin('agent-1', ptyA);
		expect(registry.isCancelled(flow.signal, undefined)).toBe(true);
	});

	it('a newer flow supersedes the older one for the same session', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const first = registry.begin('agent-1', ptyA).flow;
		const second = registry.begin('agent-1', ptyB);
		expect(second.superseded).toBe(true);
		expect(second.flow.generation).toBe(first.generation + 1);
		expect(first.signal.aborted).toBe(true);
		expect(registry.isCancelled(first.signal, ptyB)).toBe(true);
		expect(registry.isCancelled(second.flow.signal, ptyB)).toBe(false);
	});

	it('does not touch flows of other sessions', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const a = registry.begin('agent-1', ptyA).flow;
		const b = registry.begin('agent-2', ptyB).flow;
		registry.cancel('agent-1', 'session-killed');
		expect(a.signal.aborted).toBe(true);
		expect(b.signal.aborted).toBe(false);
	});

	it('explicit cancel aborts with the given reason and reports whether anything was live', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const { flow } = registry.begin('agent-1', ptyA);
		expect(registry.cancel('agent-1', 'session-killed')).toBe(true);
		expect(flow.signal.reason).toBe('session-killed');
		expect(registry.cancel('agent-1', 'session-killed')).toBe(false);
	});

	it('end() of an old flow never removes its successor', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const first = registry.begin('agent-1', ptyA).flow;
		const second = registry.begin('agent-1', ptyB).flow;
		registry.end(first);
		expect(registry.has('agent-1')).toBe(true);
		registry.end(second);
		expect(registry.has('agent-1')).toBe(false);
	});

	it('skips the PTY identity check for runtimes without a PTY', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const { flow } = registry.begin('agent-1', undefined);
		expect(registry.isCancelled(flow.signal, undefined)).toBe(false);
		expect(registry.isCancelled(flow.signal, ptyB)).toBe(false);
	});

	it('judges unknown signals by aborted alone, and undefined as not cancelled', () => {
		const registry = new RegistrationFlowRegistry<object>();
		const controller = new AbortController();
		expect(registry.isCancelled(controller.signal, ptyA)).toBe(false);
		controller.abort();
		expect(registry.isCancelled(controller.signal, ptyA)).toBe(true);
		expect(registry.isCancelled(undefined, ptyA)).toBe(false);
	});
});
