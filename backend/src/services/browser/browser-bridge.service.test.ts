/**
 * Tests for BrowserBridgeService
 *
 * @module services/browser/browser-bridge.service.test
 */

import { BrowserBridgeService } from './browser-bridge.service.js';

// Mock ws module
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

// Mock logger
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

describe('BrowserBridgeService', () => {
	beforeEach(() => {
		BrowserBridgeService.resetInstance();
	});

	afterEach(() => {
		BrowserBridgeService.resetInstance();
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

	describe('attach', () => {
		it('should attach without error', () => {
			const bridge = BrowserBridgeService.getInstance();
			const mockServer = { on: jest.fn() } as any;
			// Should not throw
			expect(() => bridge.attach(mockServer)).not.toThrow();
		});

		it('should not throw on second attach (idempotent)', () => {
			const bridge = BrowserBridgeService.getInstance();
			const mockServer = { on: jest.fn() } as any;
			bridge.attach(mockServer);
			// Second attach should not throw (warns instead)
			expect(() => bridge.attach(mockServer)).not.toThrow();
		});
	});

	describe('stop', () => {
		it('should close the WebSocket server and clean up', () => {
			const bridge = BrowserBridgeService.getInstance();
			const mockServer = { on: jest.fn() } as any;
			bridge.attach(mockServer);
			bridge.stop();
			expect(bridge.isConnected()).toBe(false);
		});

		it('should handle stop when not attached', () => {
			const bridge = BrowserBridgeService.getInstance();
			// Should not throw
			bridge.stop();
		});
	});
});
