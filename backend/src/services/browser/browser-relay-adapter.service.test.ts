/**
 * Tests for BrowserRelayAdapter
 *
 * @module services/browser/browser-relay-adapter.service.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BrowserRelayAdapter } from './browser-relay-adapter.service.js';

// Mock logger
vi.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			}),
		}),
	},
}));

// Mock CloudSyncService
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockGetState = vi.fn().mockReturnValue('syncing');

vi.mock('../cloud/cloud-sync.service.js', () => ({
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
		vi.clearAllMocks();
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
});
