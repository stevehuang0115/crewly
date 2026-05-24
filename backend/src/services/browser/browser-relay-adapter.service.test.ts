/**
 * Tests for BrowserRelayAdapter
 *
 * @module services/browser/browser-relay-adapter.service.test
 */

import { BrowserRelayAdapter } from './browser-relay-adapter.service.js';

// Mock logger
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock CloudSyncService
const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockGetState = jest.fn().mockReturnValue('syncing');

jest.mock('../cloud/cloud-sync.service.js', () => ({
	CloudSyncService: {
		getInstance: () => ({
			sendMessage: mockSendMessage,
			getState: mockGetState,
		}),
	},
}));

describe('BrowserRelayAdapter', () => {
	beforeEach(() => {
		BrowserRelayAdapter.resetInstance();
		jest.clearAllMocks();
		mockGetState.mockReturnValue('syncing');
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const a = BrowserRelayAdapter.getInstance();
			const b = BrowserRelayAdapter.getInstance();
			expect(a).toBe(b);
		});
	});

	describe('isAvailable', () => {
		it('should return false when no Extension device ID set', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			expect(adapter.isAvailable()).toBe(false);
		});

		it('should return false when CloudSync is not syncing', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');
			mockGetState.mockReturnValue('idle');
			expect(adapter.isAvailable()).toBe(false);
		});

		it('should return true when device ID set and CloudSync is syncing', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');
			expect(adapter.isAvailable()).toBe(true);
		});
	});

	describe('sendViaRelay', () => {
		it('should throw if no Extension device ID set', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			await expect(adapter.sendViaRelay('navigate', { url: 'https://example.com' }))
				.rejects.toThrow('No Extension device ID set');
		});

		it('should throw if CloudSync is not active', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');
			mockGetState.mockReturnValue('idle');
			await expect(adapter.sendViaRelay('navigate', { url: 'https://example.com' }))
				.rejects.toThrow('CloudSyncService not active');
		});

		it('should send command via CloudSyncService and wait for response', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');

			// Start sending — will pend until response arrives
			const resultPromise = adapter.sendViaRelay('navigate', { url: 'https://example.com' }, 5000);

			// Verify sendMessage was called
			expect(mockSendMessage).toHaveBeenCalledWith(
				'ext-123',
				'browser_command',
				expect.objectContaining({
					tool: 'navigate',
					params: { url: 'https://example.com' },
				}),
			);

			// Extract command ID from the sendMessage call
			const sentCommand = mockSendMessage.mock.calls[0][2];
			const commandId = sentCommand.id;

			// Simulate response arriving via relay
			adapter.handleRelayResponse({
				id: commandId,
				success: true,
				result: { title: 'Example', url: 'https://example.com' },
			});

			const result = await resultPromise;
			expect(result.success).toBe(true);
			expect(result.result).toEqual({ title: 'Example', url: 'https://example.com' });
		});

		it('should include agentName when provided', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');

			const resultPromise = adapter.sendViaRelay('screenshot', {}, 5000, 'crewly-dev');

			const sentCommand = mockSendMessage.mock.calls[0][2];
			expect(sentCommand.agentName).toBe('crewly-dev');

			adapter.handleRelayResponse({ id: sentCommand.id, success: true });
			await resultPromise;
		});

		it('should timeout if no response received', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');

			await expect(adapter.sendViaRelay('navigate', { url: 'https://slow.com' }, 50))
				.rejects.toThrow('timed out');
		});

		it('should reject if sendMessage fails', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');
			mockSendMessage.mockRejectedValueOnce(new Error('Network error'));

			await expect(adapter.sendViaRelay('navigate', { url: 'https://fail.com' }))
				.rejects.toThrow('Failed to send relay command');
		});
	});

	describe('handleRelayResponse', () => {
		it('should resolve pending command with matching ID', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');

			const promise = adapter.sendViaRelay('screenshot', {}, 5000);
			const commandId = mockSendMessage.mock.calls[0][2].id;

			adapter.handleRelayResponse({ id: commandId, success: true, result: 'base64data' });

			const result = await promise;
			expect(result.success).toBe(true);
			expect(result.result).toBe('base64data');
		});

		it('should ignore response with unknown command ID', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			// Should not throw
			adapter.handleRelayResponse({ id: 'unknown-id', success: true });
			expect(adapter.getPendingCount()).toBe(0);
		});

		it('should ignore response without ID', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.handleRelayResponse({ id: '', success: true });
			expect(adapter.getPendingCount()).toBe(0);
		});
	});

	describe('cleanup', () => {
		it('should reject all pending commands', async () => {
			const adapter = BrowserRelayAdapter.getInstance();
			adapter.setExtensionDeviceId('ext-123');

			const promise = adapter.sendViaRelay('navigate', { url: 'https://example.com' }, 60000);

			adapter.cleanup();

			await expect(promise).rejects.toThrow('shutting down');
			expect(adapter.getPendingCount()).toBe(0);
			expect(adapter.getExtensionDeviceId()).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// BrowserProxy event integration (2026-05-23 fix)
	//
	// Background: CloudSyncService device events used to be the sole signal
	// path for extension presence, but Sync only tracks orchestrator-role
	// devices in current production. As a result the adapter's
	// extensionDeviceId stayed null even when the BrowserProxy was actively
	// talking to a paired extension, and BrowserBridge.getStatus() reported
	// relayAvailable=false → dispatch silently failed. The adapter now also
	// subscribes to BrowserProxy's instance_connected / instance_disconnected
	// events. These tests exercise that path directly via the adapter's
	// private handler methods (the dynamic-import wiring of the subscribe
	// path itself is integration-tested in production logs).
	// -----------------------------------------------------------------------

	describe('BrowserProxy event handlers', () => {
		it('adopts the connected instanceId as the relay target', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			expect(adapter.getExtensionDeviceId()).toBeNull();

			// Invoke the private handler directly — exercised via dynamic-
			// import subscription in production; here we pin its semantics.
			(adapter as unknown as {
				onProxyInstanceConnected: (e: { instanceId: string; instanceName?: string }) => void;
			}).onProxyInstanceConnected({
				instanceId: '64025449-a653-4d7a-87cc-ae6c42676ee3',
				instanceName: 'Chrome (macOS)',
			});

			expect(adapter.getExtensionDeviceId()).toBe('64025449-a653-4d7a-87cc-ae6c42676ee3');
		});

		it('clears the relay target on matching disconnect', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			(adapter as unknown as {
				onProxyInstanceConnected: (e: { instanceId: string; instanceName?: string }) => void;
				onProxyInstanceDisconnected: (e: { instanceId: string; instanceName?: string }) => void;
			}).onProxyInstanceConnected({ instanceId: 'ext-abc' });
			expect(adapter.getExtensionDeviceId()).toBe('ext-abc');

			(adapter as unknown as {
				onProxyInstanceDisconnected: (e: { instanceId: string; instanceName?: string }) => void;
			}).onProxyInstanceDisconnected({ instanceId: 'ext-abc' });

			expect(adapter.getExtensionDeviceId()).toBeNull();
		});

		it('ignores disconnects for non-matching instances (multi-browser future-proof)', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			(adapter as unknown as {
				onProxyInstanceConnected: (e: { instanceId: string; instanceName?: string }) => void;
				onProxyInstanceDisconnected: (e: { instanceId: string; instanceName?: string }) => void;
			}).onProxyInstanceConnected({ instanceId: 'ext-current' });

			(adapter as unknown as {
				onProxyInstanceDisconnected: (e: { instanceId: string; instanceName?: string }) => void;
			}).onProxyInstanceDisconnected({ instanceId: 'ext-some-other' });

			expect(adapter.getExtensionDeviceId()).toBe('ext-current');
		});

		it('is idempotent — repeated connects of the same instance do not re-log', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			const connect = (adapter as unknown as {
				onProxyInstanceConnected: (e: { instanceId: string }) => void;
			}).onProxyInstanceConnected.bind(adapter);

			connect({ instanceId: 'ext-1' });
			connect({ instanceId: 'ext-1' });
			connect({ instanceId: 'ext-1' });

			expect(adapter.getExtensionDeviceId()).toBe('ext-1');
		});

		it('replaces the target when a different instance connects', () => {
			const adapter = BrowserRelayAdapter.getInstance();
			const connect = (adapter as unknown as {
				onProxyInstanceConnected: (e: { instanceId: string }) => void;
			}).onProxyInstanceConnected.bind(adapter);

			connect({ instanceId: 'ext-a' });
			expect(adapter.getExtensionDeviceId()).toBe('ext-a');
			connect({ instanceId: 'ext-b' });
			expect(adapter.getExtensionDeviceId()).toBe('ext-b');
		});
	});
});
