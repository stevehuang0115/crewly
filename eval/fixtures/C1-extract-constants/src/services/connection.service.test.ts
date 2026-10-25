/**
 * Existing tests for ConnectionService — must continue to pass after refactoring.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionService } from './connection.service.js';

describe('ConnectionService', () => {
  let service: ConnectionService;

  beforeEach(() => {
    service = new ConnectionService();
  });

  it('should start disconnected', () => {
    expect(service.getStatus()).toBe('disconnected');
  });

  it('should connect to API', async () => {
    await service.connectApi();
    expect(service.getStatus()).toBe('connected');
  });

  it('should connect to WebSocket', async () => {
    await service.connectWebSocket();
    expect(service.getStatus()).toBe('connected');
  });

  it('should connect to admin', async () => {
    await service.connectAdmin();
    expect(service.getStatus()).toBe('connected');
  });

  it('should reset state', async () => {
    await service.connectApi();
    service.reset();
    expect(service.getStatus()).toBe('disconnected');
    expect(service.getRetryCount()).toBe(0);
  });

  it('should track retry count', () => {
    expect(service.getRetryCount()).toBe(0);
  });
});
