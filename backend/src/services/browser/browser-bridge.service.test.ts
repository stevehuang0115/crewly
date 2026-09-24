/**
 * Tests for BrowserBridgeService
 *
 * Covers the original singleton/lifecycle surface AND the per-tab dispatch
 * binding map (1 agent : 1 tab) introduced for the Crewly-in-Chrome
 * concurrent-agent fix. See `.crewly/specs/crewly-in-chrome-per-tab-fix-2026-04-25.md`.
 *
 * @module services/browser/browser-bridge.service.test
 */

import {
	BrowserBridgeService,
	type BrowserCommandResponse,
	type ExtensionTabDescriptor,
} from './browser-bridge.service.js';
import { BROWSER_BRIDGE_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Mocks: ws + logger. The binding suite never spins up a real server — it
// stubs sendCommand to control Extension responses deterministically.
// ---------------------------------------------------------------------------

jest.mock('ws', () => {
	class MockWebSocketServer {
		on = jest.fn();
		close = jest.fn();
		constructor() {
			// no-op
		}
	}
	return {
		WebSocketServer: MockWebSocketServer,
		WebSocket: { OPEN: 1, CLOSED: 3 },
	};
});

jest.mock('../cloud/device-identity.service.js', () => ({
	DeviceIdentityService: {
		getInstance: () => ({ getDeviceId: async () => 'device-this-backend' }),
	},
}));

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				debug: jest.fn(),
			}),
		}),
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Patch a service instance's `sendCommand` with a queued-response stub.
 * Each call returns the next response from the queue (or a generic success
 * if the queue is empty). Records the call args for assertions.
 */
function stubSendCommand(
	bridge: BrowserBridgeService,
	queue: BrowserCommandResponse[]
): jest.SpyInstance {
	const calls: Array<{ tool: string; params?: Record<string, unknown> }> = [];
	const spy = jest
		.spyOn(bridge, 'sendCommand')
		.mockImplementation(async (tool, params) => {
			calls.push({ tool, params });
			const next = queue.shift();
			return (
				next ??
				({
					id: `stub-${calls.length}`,
					success: true,
					result: {},
				} as BrowserCommandResponse)
			);
		});
	(spy as unknown as { calls: typeof calls }).calls = calls;
	return spy;
}

// ---------------------------------------------------------------------------
// Existing surface — unchanged from previous version
// ---------------------------------------------------------------------------

describe('BrowserBridgeService', () => {
	beforeEach(() => {
		BrowserBridgeService.resetInstance();
	});

	afterEach(() => {
		BrowserBridgeService.resetInstance();
		// Tests that override env vars must also clean up; do it here as a safety net.
		delete process.env.CREWLY_TAB_BIND_MAX;
		delete process.env.CREWLY_TAB_BIND_TTL_MINUTES;
	});

	describe('getInstance', () => {
		it('should return a singleton instance', () => {
			const a = BrowserBridgeService.getInstance();
			const b = BrowserBridgeService.getInstance();
			expect(a).toBe(b);
		});

		it('should return a new instance after resetInstance', () => {
			const a = BrowserBridgeService.getInstance();
			BrowserBridgeService.resetInstance();
			const b = BrowserBridgeService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('getStatus', () => {
		it('should return disconnected status with no clients', () => {
			const bridge = BrowserBridgeService.getInstance();
			const status = bridge.getStatus();
			expect(status.connected).toBe(false);
			expect(status.clientCount).toBe(0);
			expect(status.wsPath).toBe('/ws/browser');
			// New per-tab field — initially zero.
			expect(status.bindingCount).toBe(0);
		});
	});

	describe('isConnected', () => {
		it('should return false when no clients are connected', () => {
			const bridge = BrowserBridgeService.getInstance();
			expect(bridge.isConnected()).toBe(false);
		});
	});

	describe('sendCommand', () => {
		it('should throw when no client is connected', async () => {
			const bridge = BrowserBridgeService.getInstance();
			await expect(bridge.sendCommand('navigate', { url: 'https://example.com' }))
				.rejects.toThrow('No Chrome Extension connected');
		});
	});

	// -----------------------------------------------------------------------
	// Fallback ordering when there is no direct WS client (2026-05-23 fix)
	//
	// Before: bridge → BrowserRelayAdapter.sendViaRelay → CloudSync.sendMessage.
	// Sync didn't know the extension's deviceId so dispatch was a no-op.
	//
	// After: bridge prefers BrowserProxyService.sendCommand (the proxy's
	// direct relay channel — the path that actually delivered work on 5/20).
	// The legacy adapter is kept only as a last-resort hedge.
	// -----------------------------------------------------------------------

	describe('sendCommand — fallback ordering', () => {
		it('routes through BrowserProxy when proxy reports available (preferred path)', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const { BrowserProxyService } = await import('./browser-proxy.service.js');
			const { BrowserRelayAdapter } = await import('./browser-relay-adapter.service.js');
			const proxy = BrowserProxyService.getInstance();
			const adapter = BrowserRelayAdapter.getInstance();

			const proxySpy = jest
				.spyOn(proxy, 'sendCommand')
				.mockResolvedValue({ id: 'p-1', success: true, result: { ok: true } });
			const proxyAvailableSpy = jest.spyOn(proxy, 'isAvailable').mockReturnValue(true);
			const adapterSpy = jest
				.spyOn(adapter, 'sendViaRelay')
				.mockResolvedValue({ id: 'a-1', success: true });

			const resp = await bridge.sendCommand('navigate', { url: 'https://example.com' });

			expect(resp.id).toBe('p-1');
			expect(proxySpy).toHaveBeenCalledTimes(1);
			expect(adapterSpy).not.toHaveBeenCalled();

			proxySpy.mockRestore();
			proxyAvailableSpy.mockRestore();
			adapterSpy.mockRestore();
		});

		it('falls back to adapter only when proxy is NOT available', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const { BrowserProxyService } = await import('./browser-proxy.service.js');
			const { BrowserRelayAdapter } = await import('./browser-relay-adapter.service.js');
			const proxy = BrowserProxyService.getInstance();
			const adapter = BrowserRelayAdapter.getInstance();

			const proxyAvailableSpy = jest.spyOn(proxy, 'isAvailable').mockReturnValue(false);
			const proxySpy = jest.spyOn(proxy, 'sendCommand');
			const adapterAvailableSpy = jest.spyOn(adapter, 'isAvailable').mockReturnValue(true);
			const adapterSpy = jest
				.spyOn(adapter, 'sendViaRelay')
				.mockResolvedValue({ id: 'a-2', success: true });

			const resp = await bridge.sendCommand('navigate', { url: 'https://example.com' });

			expect(resp.id).toBe('a-2');
			expect(proxySpy).not.toHaveBeenCalled();
			expect(adapterSpy).toHaveBeenCalledTimes(1);

			proxySpy.mockRestore();
			proxyAvailableSpy.mockRestore();
			adapterAvailableSpy.mockRestore();
			adapterSpy.mockRestore();
		});

		it('throws when neither proxy nor adapter is available', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const { BrowserProxyService } = await import('./browser-proxy.service.js');
			const { BrowserRelayAdapter } = await import('./browser-relay-adapter.service.js');
			const proxy = BrowserProxyService.getInstance();
			const adapter = BrowserRelayAdapter.getInstance();

			const proxyAvailableSpy = jest.spyOn(proxy, 'isAvailable').mockReturnValue(false);
			const adapterAvailableSpy = jest.spyOn(adapter, 'isAvailable').mockReturnValue(false);

			await expect(bridge.sendCommand('navigate', { url: 'https://example.com' })).rejects.toThrow(
				/No Chrome Extension connected/,
			);

			proxyAvailableSpy.mockRestore();
			adapterAvailableSpy.mockRestore();
		});
	});

	describe('getStatus + isConnected — proxy primary, adapter fallback', () => {
		it('reports relayAvailable=true and relayDeviceId from proxy when proxy has an instance', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const { BrowserProxyService } = await import('./browser-proxy.service.js');
			const proxy = BrowserProxyService.getInstance();

			const proxyAvailableSpy = jest.spyOn(proxy, 'isAvailable').mockReturnValue(true);
			const proxyInstancesSpy = jest.spyOn(proxy, 'getInstances').mockReturnValue([
				{
					instanceId: 'ext-64025449',
					instanceName: 'Chrome (macOS)',
					sessionId: 'sess-1',
					lastSeenAt: new Date().toISOString(),
				},
			]);

			const status = bridge.getStatus();
			expect(status.relayAvailable).toBe(true);
			expect(status.relayDeviceId).toBe('ext-64025449');
			expect(bridge.isConnected()).toBe(true);

			proxyAvailableSpy.mockRestore();
			proxyInstancesSpy.mockRestore();
		});

		it('does not consult adapter when proxy already reports availability', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const { BrowserProxyService } = await import('./browser-proxy.service.js');
			const { BrowserRelayAdapter } = await import('./browser-relay-adapter.service.js');
			const proxy = BrowserProxyService.getInstance();
			const adapter = BrowserRelayAdapter.getInstance();

			const proxyAvailableSpy = jest.spyOn(proxy, 'isAvailable').mockReturnValue(true);
			const proxyInstancesSpy = jest.spyOn(proxy, 'getInstances').mockReturnValue([
				{
					instanceId: 'ext-1',
					instanceName: 'Chrome',
					sessionId: 's1',
					lastSeenAt: new Date().toISOString(),
				},
			]);
			const adapterAvailableSpy = jest.spyOn(adapter, 'isAvailable');

			bridge.getStatus();
			expect(adapterAvailableSpy).not.toHaveBeenCalled();

			proxyAvailableSpy.mockRestore();
			proxyInstancesSpy.mockRestore();
			adapterAvailableSpy.mockRestore();
		});
	});

	describe('attach', () => {
		it('should attach without error', () => {
			const bridge = BrowserBridgeService.getInstance();
			const mockServer = { on: jest.fn(), emit: jest.fn() } as unknown as Parameters<
				typeof bridge.attach
			>[0];
			expect(() => bridge.attach(mockServer)).not.toThrow();
		});

		it('should not throw on second attach (idempotent)', () => {
			const bridge = BrowserBridgeService.getInstance();
			const mockServer = { on: jest.fn(), emit: jest.fn() } as unknown as Parameters<
				typeof bridge.attach
			>[0];
			bridge.attach(mockServer);
			expect(() => bridge.attach(mockServer)).not.toThrow();
		});
	});

	describe('stop', () => {
		it('should close the WebSocket server and clean up', () => {
			const bridge = BrowserBridgeService.getInstance();
			const mockServer = { on: jest.fn(), emit: jest.fn() } as unknown as Parameters<
				typeof bridge.attach
			>[0];
			bridge.attach(mockServer);
			bridge.stop();
			expect(bridge.isConnected()).toBe(false);
		});

		it('should handle stop when not attached', () => {
			const bridge = BrowserBridgeService.getInstance();
			bridge.stop();
		});

		it('should clear active bindings on stop', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 11 } },
			]);
			await bridge.bindAgentTab('agent-stop-test');
			expect(bridge.listBindings()).toHaveLength(1);

			bridge.stop();
			expect(bridge.listBindings()).toHaveLength(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Per-tab dispatch (§3.2 — 1 agent : 1 tab)
// ---------------------------------------------------------------------------

describe('BrowserBridgeService — per-tab dispatch', () => {
	beforeEach(() => {
		BrowserBridgeService.resetInstance();
	});

	afterEach(() => {
		BrowserBridgeService.resetInstance();
		delete process.env.CREWLY_TAB_BIND_MAX;
		delete process.env.CREWLY_TAB_BIND_TTL_MINUTES;
	});

	// -------------------------------------------------------------------------
	// bindAgentTab
	// -------------------------------------------------------------------------

	describe('bindAgentTab', () => {
		it('rejects empty agentSession', async () => {
			const bridge = BrowserBridgeService.getInstance();
			await expect(bridge.bindAgentTab('')).rejects.toThrow(/non-empty agentSession/);
		});

		it('forwards bindTab to Extension and stores the binding', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 'r1', success: true, result: { tabId: 42, windowId: 9 } },
			]);

			const binding = await bridge.bindAgentTab('agent-A');

			expect(binding.agentSession).toBe('agent-A');
			expect(binding.tabId).toBe(42);
			expect(binding.windowId).toBe(9);
			expect(binding.boundAt).toBeInstanceOf(Date);
			expect(binding.lastActivityAt).toBeInstanceOf(Date);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0]).toBe('bindTab');
			expect(spy.mock.calls[0]?.[1]).toEqual({ active: false });

			expect(bridge.getStatus().bindingCount).toBe(1);
			expect(bridge.listBindings()).toHaveLength(1);
		});

		it('is idempotent — second bind returns existing binding without WS call', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 'r1', success: true, result: { tabId: 42 } },
			]);

			const first = await bridge.bindAgentTab('agent-A');
			const second = await bridge.bindAgentTab('agent-A');

			expect(spy).toHaveBeenCalledTimes(1);
			expect(second.tabId).toBe(first.tabId);
			expect(second.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
				first.lastActivityAt.getTime()
			);
			expect(bridge.listBindings()).toHaveLength(1);
		});

		it('passes active:true when foreground=true', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 'r1', success: true, result: { tabId: 7 } },
			]);

			await bridge.bindAgentTab('agent-fg', { foreground: true });

			expect(spy.mock.calls[0]?.[1]).toEqual({ active: true });
		});

		it('rejects with tab_pool_full when at hard cap', async () => {
			process.env.CREWLY_TAB_BIND_MAX = '2';
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'r1', success: true, result: { tabId: 1 } },
				{ id: 'r2', success: true, result: { tabId: 2 } },
			]);

			await bridge.bindAgentTab('a1');
			await bridge.bindAgentTab('a2');

			await expect(bridge.bindAgentTab('a3')).rejects.toThrow(/tab_pool_full/);

			expect(bridge.listBindings()).toHaveLength(2);
		});

		it('throws when Extension reports failure', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'r1', success: false, error: 'no-permission' },
			]);

			await expect(bridge.bindAgentTab('agent-A')).rejects.toThrow(/no-permission/);
			expect(bridge.listBindings()).toHaveLength(0);
		});

		it('throws when Extension response lacks tabId', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [{ id: 'r1', success: true, result: {} }]);

			await expect(bridge.bindAgentTab('agent-A')).rejects.toThrow(/missing numeric tabId/);
			expect(bridge.listBindings()).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// unbindAgentTab
	// -------------------------------------------------------------------------

	describe('unbindAgentTab', () => {
		it('returns released:false when no binding exists', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const result = await bridge.unbindAgentTab('agent-nope');
			expect(result).toEqual({ released: false, tabClosed: false });
		});

		it('removes binding and asks Extension to close the tab by default', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'u1', success: true, result: {} },
			]);

			await bridge.bindAgentTab('agent-A');
			const result = await bridge.unbindAgentTab('agent-A');

			expect(result).toEqual({ released: true, tabClosed: true });
			expect(bridge.listBindings()).toHaveLength(0);

			// Second sendCommand call is the unbindTab.
			expect(spy.mock.calls[1]?.[0]).toBe('unbindTab');
			expect(spy.mock.calls[1]?.[1]).toEqual({ tabId: 42 });
		});

		it('skips Extension close when closeTab=false', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);

			await bridge.bindAgentTab('agent-A');
			const result = await bridge.unbindAgentTab('agent-A', { closeTab: false });

			expect(result).toEqual({ released: true, tabClosed: false });
			expect(spy).toHaveBeenCalledTimes(1); // only the bindTab call
		});

		it('still clears binding when Extension call rejects', async () => {
			const bridge = BrowserBridgeService.getInstance();
			let bindCalled = false;
			jest
				.spyOn(bridge, 'sendCommand')
				.mockImplementation(async (tool) => {
					if (tool === 'bindTab') {
						bindCalled = true;
						return { id: 'b1', success: true, result: { tabId: 42 } };
					}
					throw new Error('extension offline');
				});

			await bridge.bindAgentTab('agent-A');
			expect(bindCalled).toBe(true);

			const result = await bridge.unbindAgentTab('agent-A');
			expect(result).toEqual({ released: true, tabClosed: false });
			expect(bridge.listBindings()).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// sendCommandForAgent — resolution priority (§4.2)
	// -------------------------------------------------------------------------

	describe('sendCommandForAgent', () => {
		it('passes through when no agentSession is supplied (legacy active-tab path)', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 's1', success: true, result: { ok: true } },
			]);

			await bridge.sendCommandForAgent(undefined, 'read-text', { selector: 'h1' });

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0]).toBe('read-text');
			expect(spy.mock.calls[0]?.[1]).toEqual({ selector: 'h1' });
		});

		it('passes through when params has explicit numeric tabId override', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 's1', success: true, result: { ok: true } },
			]);

			await bridge.sendCommandForAgent('agent-A', 'read-text', { tabId: 99 });

			// Single call — no auto-bind triggered when tabId already specified.
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[1]).toEqual({ tabId: 99 });
			expect(bridge.listBindings()).toHaveLength(0);
		});

		it('uses existing binding and bumps lastActivityAt', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'c1', success: true, result: { ok: true } },
			]);

			const binding = await bridge.bindAgentTab('agent-A');
			const initialActivity = binding.lastActivityAt.getTime();

			// Advance clock a few ms via setTimeout(0) — Date.now is fine because
			// `lastActivityAt` is set with `new Date()`.
			await new Promise((r) => setTimeout(r, 5));

			await bridge.sendCommandForAgent('agent-A', 'read-text');

			const afterBinding = bridge.getBinding('agent-A')!;
			expect(afterBinding.tabId).toBe(42);
			expect(afterBinding.lastActivityAt.getTime()).toBeGreaterThan(initialActivity);
		});

		it('auto-binds on first call when agent has no binding', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const spy = stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 13 } },
				{ id: 'c1', success: true, result: { ok: true } },
			]);

			await bridge.sendCommandForAgent('agent-fresh', 'navigate', {
				url: 'https://example.com',
			});

			// First call = bindTab, second = navigate with injected tabId.
			expect(spy).toHaveBeenCalledTimes(2);
			expect(spy.mock.calls[0]?.[0]).toBe('bindTab');
			expect(spy.mock.calls[1]?.[0]).toBe('navigate');
			expect(spy.mock.calls[1]?.[1]).toEqual({
				url: 'https://example.com',
				tabId: 13,
			});
		});
	});

	// -------------------------------------------------------------------------
	// handleTabRemoved + handleTabInventory (§4.3 / §4.4)
	// -------------------------------------------------------------------------

	describe('handleTabRemoved', () => {
		it('clears the binding whose tabId matches', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'b2', success: true, result: { tabId: 43 } },
			]);

			await bridge.bindAgentTab('agent-A');
			await bridge.bindAgentTab('agent-B');

			bridge.handleTabRemoved(42);

			expect(bridge.getBinding('agent-A')).toBeUndefined();
			expect(bridge.getBinding('agent-B')?.tabId).toBe(43);
		});

		it('is a no-op for unknown tabId', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);
			await bridge.bindAgentTab('agent-A');

			bridge.handleTabRemoved(999);

			expect(bridge.listBindings()).toHaveLength(1);
		});
	});

	describe('handleTabInventory', () => {
		it('drops bindings for tabIds missing from Extension inventory', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'b2', success: true, result: { tabId: 43 } },
				{ id: 'b3', success: true, result: { tabId: 44 } },
			]);
			await bridge.bindAgentTab('agent-A');
			await bridge.bindAgentTab('agent-B');
			await bridge.bindAgentTab('agent-C');

			// Extension reports only 42 + 44 — 43 has been closed.
			const tabs: ExtensionTabDescriptor[] = [
				{ tabId: 42, crewlyOwned: true },
				{ tabId: 44, crewlyOwned: true },
			];
			bridge.handleTabInventory(tabs);

			expect(bridge.getBinding('agent-A')).toBeDefined();
			expect(bridge.getBinding('agent-B')).toBeUndefined();
			expect(bridge.getBinding('agent-C')).toBeDefined();
		});

		it('closes a Crewly tab this backend created and no longer has bound (own orphan)', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);
			await bridge.bindAgentTab('agent-A');
			// Release the binding but leave the tab open (as a failed close would).
			await bridge.unbindAgentTab('agent-A', { closeTab: false });

			const { orphans } = bridge.handleTabInventory([{ tabId: 42, crewlyOwned: true }]);

			expect(orphans).toEqual([42]);
		});

		it('does NOT close a Crewly tab in the inventory that this backend never created or bound', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);
			await bridge.bindAgentTab('agent-A');

			// 1383674334 is another client's agent tab in the shared Crewly group,
			// delivered to us by the relay's account-wide inventory broadcast.
			const tabs: ExtensionTabDescriptor[] = [
				{ tabId: 42, crewlyOwned: true }, // ours, bound
				{ tabId: 1383674334, crewlyOwned: true, url: 'https://x.com/' }, // not ours
				{ tabId: 51, crewlyOwned: false }, // user's own tab
			];
			const { orphans } = bridge.handleTabInventory(tabs);

			expect(orphans).toEqual([]);
			expect(bridge.listBindings()).toHaveLength(1);
		});

		it('does not close its own tab while an agent still has it bound', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);
			await bridge.bindAgentTab('agent-A');

			const { orphans } = bridge.handleTabInventory([{ tabId: 42, crewlyOwned: true }]);

			expect(orphans).toEqual([]);
			expect(bridge.getBinding('agent-A')?.tabId).toBe(42);
		});

		it('closes only its own orphan when own and foreign unbound Crewly tabs are mixed', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'b2', success: true, result: { tabId: 43 } },
			]);
			await bridge.bindAgentTab('agent-A');
			await bridge.bindAgentTab('agent-B');
			await bridge.unbindAgentTab('agent-B', { closeTab: false });

			const { orphans } = bridge.handleTabInventory([
				{ tabId: 42, crewlyOwned: true },
				{ tabId: 43, crewlyOwned: true },
				{ tabId: 1383674346, crewlyOwned: true },
				{ tabId: 1383674337, crewlyOwned: true },
			]);

			expect(orphans).toEqual([43]);
		});

		it('forgets an owned tab once the Extension reports it removed', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);
			await bridge.bindAgentTab('agent-A');
			await bridge.unbindAgentTab('agent-A', { closeTab: false });
			bridge.handleTabRemoved(42);

			// Chrome may reuse ids across profiles/sessions: a later tab 42 is not ours.
			const { orphans } = bridge.handleTabInventory([{ tabId: 42, crewlyOwned: true }]);

			expect(orphans).toEqual([]);
		});

		it('forgets owned tabs on stop(), so a restarted bridge closes nothing', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);
			await bridge.bindAgentTab('agent-A');
			bridge.stop();

			const { orphans } = bridge.handleTabInventory([{ tabId: 42, crewlyOwned: true }]);

			expect(orphans).toEqual([]);
		});

		it('ignores entries without a numeric tabId', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 7 } },
			]);
			await bridge.bindAgentTab('agent-A');
			await bridge.unbindAgentTab('agent-A', { closeTab: false });
			const tabs = [
				{ url: 'no-id' } as ExtensionTabDescriptor,
				{ tabId: 7, crewlyOwned: true },
			];
			const { orphans } = bridge.handleTabInventory(tabs);
			expect(orphans).toEqual([7]);
		});
	});

	// -------------------------------------------------------------------------
	// runSweepOnce
	// -------------------------------------------------------------------------

	describe('runSweepOnce', () => {
		it('evicts bindings whose lastActivityAt exceeds TTL', async () => {
			process.env.CREWLY_TAB_BIND_TTL_MINUTES = '0.001'; // 60ms
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'b2', success: true, result: { tabId: 43 } },
			]);

			await bridge.bindAgentTab('agent-A');
			await bridge.bindAgentTab('agent-B');

			// Wait past the TTL.
			await new Promise((r) => setTimeout(r, 80));

			const evicted = await bridge.runSweepOnce();
			expect(evicted).toBe(2);
			expect(bridge.listBindings()).toHaveLength(0);
		});

		it('keeps fresh bindings untouched', async () => {
			process.env.CREWLY_TAB_BIND_TTL_MINUTES = '60';
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
			]);

			await bridge.bindAgentTab('agent-A');

			const evicted = await bridge.runSweepOnce();
			expect(evicted).toBe(0);
			expect(bridge.listBindings()).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// Several browsers / backends on one Cloud account (incident 2026-09-23)
	// -------------------------------------------------------------------------

	describe('bindings are judged only against their own browser', () => {
		it('records the relay instance a tab was bound on', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 }, instanceId: 'inst-A' },
			]);

			await bridge.bindAgentTab('agent-A');

			expect(bridge.getBinding('agent-A')?.instanceId).toBe('inst-A');
		});

		it("keeps a binding when another browser's inventory lacks its tab", async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 }, instanceId: 'inst-A' },
			]);
			await bridge.bindAgentTab('agent-A');

			bridge.handleTabInventory([{ tabId: 7, crewlyOwned: false }], 'inst-B');

			expect(bridge.getBinding('agent-A')?.tabId).toBe(42);
		});

		it("drops a binding when its own browser's inventory lacks the tab", async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 }, instanceId: 'inst-A' },
			]);
			await bridge.bindAgentTab('agent-A');

			bridge.handleTabInventory([{ tabId: 7, crewlyOwned: false }], 'inst-A');

			expect(bridge.getBinding('agent-A')).toBeUndefined();
		});

		it('leaves a direct-socket binding alone for a relay inventory, and vice versa', async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [
				{ id: 'b1', success: true, result: { tabId: 42 } },
				{ id: 'b2', success: true, result: { tabId: 43 }, instanceId: 'inst-A' },
			]);
			await bridge.bindAgentTab('agent-direct');
			await bridge.bindAgentTab('agent-relay');

			bridge.handleTabInventory([], 'inst-A');
			expect(bridge.getBinding('agent-direct')?.tabId).toBe(42);
			expect(bridge.getBinding('agent-relay')).toBeUndefined();

			bridge.handleTabInventory([]);
			expect(bridge.getBinding('agent-direct')).toBeUndefined();
		});
	});

	describe('clientId on commands', () => {
		it('resolves this backend device id as the clientId', async () => {
			const bridge = BrowserBridgeService.getInstance();
			await expect(bridge.getClientId()).resolves.toBe('device-this-backend');
		});

		it('sends the clientId with a command over a direct socket', async () => {
			const bridge = BrowserBridgeService.getInstance();
			const send = jest.fn();
			(bridge as unknown as { clients: Map<string, unknown> }).clients.set('c1', {
				id: 'c1',
				ws: { readyState: 1, send },
				connectedAt: new Date(),
			});

			void bridge.sendCommand('readText', { tabId: 5 }, 50).catch(() => undefined);
			await new Promise((r) => setTimeout(r, 10));

			expect(send).toHaveBeenCalledTimes(1);
			const sent = JSON.parse(send.mock.calls[0][0] as string) as Record<string, unknown>;
			expect(sent).toMatchObject({ tool: 'readText', clientId: 'device-this-backend' });
		});

		it("sends the clientId on the direct socket's orphan close, so the extension does not refuse our own sweep", async () => {
			const bridge = BrowserBridgeService.getInstance();
			stubSendCommand(bridge, [{ id: 'b1', success: true, result: { tabId: 42 } }]);
			await bridge.bindAgentTab('agent-A');
			await bridge.unbindAgentTab('agent-A', { closeTab: false });
			await bridge.getClientId();
			const send = jest.fn();
			(bridge as unknown as { clients: Map<string, unknown> }).clients.set('c1', {
				id: 'c1',
				ws: { readyState: 1, send },
				connectedAt: new Date(),
			});

			(bridge as unknown as { handleMessage: (id: string, data: unknown) => void }).handleMessage(
				'c1',
				JSON.stringify({ type: 'tabInventory', tabs: [{ tabId: 42, crewlyOwned: true }] }),
			);

			const frames = send.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
			const close = frames.find((f) => f.tool === 'unbindTab');
			expect(close).toMatchObject({ params: { tabId: 42 }, clientId: 'device-this-backend' });
		});
	});
});

// ---------------------------------------------------------------------------
// Outdated extension: "Unknown tool: bindTab" → EXTENSION_OUTDATED.
// Extensions older than 0.4.14 (e.g. store 0.4.12) do not implement bindTab.
// ---------------------------------------------------------------------------

/** Minimal view of the bridge internals needed to simulate a direct client. */
interface BridgeInternals {
	clients: Map<string, { id: string; ws: { readyState: number; send: jest.Mock }; connectedAt: Date }>;
	handleMessage: (clientId: string, data: unknown) => void;
}

/** Attach a fake OPEN direct client and deliver messages as if it sent them. */
function attachDirectClient(bridge: BrowserBridgeService, clientId = 'c1'): (msg: object) => void {
	const internals = bridge as unknown as BridgeInternals;
	internals.clients.set(clientId, {
		id: clientId,
		ws: { readyState: 1, send: jest.fn() },
		connectedAt: new Date(),
	});
	return (msg: object) => internals.handleMessage(clientId, JSON.stringify(msg));
}

describe('bindAgentTab on an extension without bindTab', () => {
	beforeEach(() => {
		BrowserBridgeService.resetInstance();
	});

	afterEach(() => {
		BrowserBridgeService.resetInstance();
		jest.restoreAllMocks();
	});

	it('throws EXTENSION_OUTDATED naming the minimum version and the fix on an "Unknown tool: bindTab" reply', async () => {
		const bridge = BrowserBridgeService.getInstance();
		stubSendCommand(bridge, [{ id: 'b1', success: false, error: 'Unknown tool: bindTab' }]);

		const err = await bridge.bindAgentTab('agent-A').catch((e: unknown) => e);

		expect((err as Error & { code?: string }).code).toBe('EXTENSION_OUTDATED');
		expect((err as Error).message).toContain(`needs ${BROWSER_BRIDGE_CONSTANTS.MIN_EXTENSION_VERSION_PER_TAB} or newer`);
		expect((err as Error).message).toContain('Update Crewly in Chrome from the Chrome Web Store');
		expect((err as Error).message).toContain('did not report its version');
		expect(bridge.getBinding('agent-A')).toBeUndefined();
	});

	it('names the version the extension reported in its identity message (direct path)', async () => {
		const bridge = BrowserBridgeService.getInstance();
		const send = attachDirectClient(bridge);
		send({ type: 'identity', instanceId: 'i1', version: '0.4.12' });
		stubSendCommand(bridge, [{ id: 'b1', success: false, error: 'Unknown tool: bindTab' }]);

		const err = await bridge.bindAgentTab('agent-A').catch((e: unknown) => e);

		expect((err as Error & { code?: string }).code).toBe('EXTENSION_OUTDATED');
		expect((err as Error).message).toContain('it reports version 0.4.12');
		expect((err as Error & { reportedVersion?: string }).reportedVersion).toBe('0.4.12');
	});

	it('records the version from identity:update too, and ignores a non-string version', async () => {
		const bridge = BrowserBridgeService.getInstance();
		const send = attachDirectClient(bridge);
		send({ type: 'identity', version: 42 });
		send({ type: 'identity:update', version: '0.4.13' });
		stubSendCommand(bridge, [{ id: 'b1', success: false, error: 'Unknown tool: bindTab' }]);

		const err = await bridge.bindAgentTab('agent-A').catch((e: unknown) => e);

		expect((err as Error).message).toContain('it reports version 0.4.13');
	});

	it('keeps the existing error for any other bind failure', async () => {
		const bridge = BrowserBridgeService.getInstance();
		stubSendCommand(bridge, [{ id: 'b1', success: false, error: 'permission_denied' }]);

		const err = await bridge.bindAgentTab('agent-A').catch((e: unknown) => e);

		expect((err as Error).message).toBe('Extension refused bindTab: permission_denied');
		expect((err as Error & { code?: string }).code).toBeUndefined();
	});

	it('does not treat a different unknown tool or a near-miss message as outdated', async () => {
		const bridge = BrowserBridgeService.getInstance();
		stubSendCommand(bridge, [
			{ id: 'b1', success: false, error: 'Unknown tool: navigate' },
			{ id: 'b2', success: false, error: 'Unknown tool: bindTabs' },
		]);

		const first = await bridge.bindAgentTab('agent-A').catch((e: unknown) => e);
		const second = await bridge.bindAgentTab('agent-A').catch((e: unknown) => e);

		expect((first as Error & { code?: string }).code).toBeUndefined();
		expect((second as Error & { code?: string }).code).toBeUndefined();
		expect((first as Error).message).toBe('Extension refused bindTab: Unknown tool: navigate');
	});
});
