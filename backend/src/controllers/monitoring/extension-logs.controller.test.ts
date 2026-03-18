/**
 * Extension Logs Controller Tests
 *
 * @module controllers/monitoring/extension-logs.controller.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { receiveExtensionLogs } from './extension-logs.controller.js';
import { InProcessLogBuffer } from '../../services/agent/crewly-agent/in-process-log-buffer.js';

describe('receiveExtensionLogs', () => {
  let mockReq: Partial<Request>;
  let mockRes: Record<string, unknown>;
  let resJson: jest.Mock;
  let resStatus: jest.Mock;

  beforeEach(() => {
    InProcessLogBuffer.resetInstance();
    resJson = jest.fn();
    resStatus = jest.fn().mockReturnValue({ json: resJson });
    mockRes = {
      json: resJson,
      status: resStatus,
    };
  });

  it('should return 400 when logs array is missing', () => {
    mockReq = { body: {} };
    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);
    expect(resStatus).toHaveBeenCalledWith(400);
    expect(resJson).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('should return 400 when logs is not an array', () => {
    mockReq = { body: { logs: 'not-an-array' } };
    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);
    expect(resStatus).toHaveBeenCalledWith(400);
  });

  it('should accept valid log batch and write to buffer', () => {
    mockReq = {
      body: {
        source: 'chrome-extension',
        logs: [
          { timestamp: '2026-03-18T10:00:00Z', level: 'info', message: 'Connected to ws://localhost:9222' },
          { timestamp: '2026-03-18T10:00:01Z', level: 'error', message: 'Tool failed', data: { tool: 'navigate' } },
        ],
      },
    };

    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);

    expect(resJson).toHaveBeenCalledWith({ received: 2 });

    const buffer = InProcessLogBuffer.getInstance();
    expect(buffer.hasSession('chrome-extension')).toBe(true);
    const output = buffer.capture('chrome-extension');
    expect(output).toContain('Connected to ws://localhost:9222');
    expect(output).toContain('Tool failed');
    expect(output).toContain('"tool":"navigate"');
  });

  it('should skip entries without a message', () => {
    mockReq = {
      body: {
        source: 'chrome-extension',
        logs: [
          { timestamp: '2026-03-18T10:00:00Z', level: 'info', message: 'Valid log' },
          { timestamp: '2026-03-18T10:00:01Z', level: 'info', message: '' },
          { timestamp: '2026-03-18T10:00:02Z', level: 'info' },
        ],
      },
    };

    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);

    expect(resJson).toHaveBeenCalledWith({ received: 1 });
  });

  it('should default to info level for unknown levels', () => {
    mockReq = {
      body: {
        source: 'chrome-extension',
        logs: [
          { timestamp: '2026-03-18T10:00:00Z', level: 'trace', message: 'Unknown level log' },
        ],
      },
    };

    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);

    expect(resJson).toHaveBeenCalledWith({ received: 1 });
    const buffer = InProcessLogBuffer.getInstance();
    const output = buffer.capture('chrome-extension');
    // Should be logged as 'info' (no prefix) not 'trace'
    expect(output).toContain('Unknown level log');
    expect(output).not.toContain('TRACE');
  });

  it('should register chrome-extension session on first call', () => {
    const buffer = InProcessLogBuffer.getInstance();
    expect(buffer.hasSession('chrome-extension')).toBe(false);

    mockReq = {
      body: {
        source: 'chrome-extension',
        logs: [{ timestamp: '2026-03-18T10:00:00Z', level: 'info', message: 'First log' }],
      },
    };

    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);
    expect(buffer.hasSession('chrome-extension')).toBe(true);
  });

  it('should not re-register session on subsequent calls', () => {
    const buffer = InProcessLogBuffer.getInstance();
    buffer.registerSession('chrome-extension');
    buffer.append('chrome-extension', 'info', 'Existing log');

    mockReq = {
      body: {
        source: 'chrome-extension',
        logs: [{ timestamp: '2026-03-18T10:00:00Z', level: 'info', message: 'New log' }],
      },
    };

    receiveExtensionLogs(mockReq as Request, mockRes as unknown as Response);

    const output = buffer.capture('chrome-extension');
    expect(output).toContain('Existing log');
    expect(output).toContain('New log');
  });
});
