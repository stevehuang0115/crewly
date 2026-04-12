/**
 * Tests for RequestTracker — correlation between user messages and task delegations.
 *
 * @module services/v3/request-tracker.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestTracker } from './request-tracker.service.js';

describe('RequestTracker', () => {
  let tracker: RequestTracker;

  beforeEach(() => {
    RequestTracker.resetInstance();
    tracker = new RequestTracker();
  });

  afterEach(() => {
    RequestTracker.resetInstance();
    vi.restoreAllMocks();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = RequestTracker.getInstance();
      const b = RequestTracker.getInstance();
      expect(a).toBe(b);
    });

    it('should create a new instance after reset', () => {
      const a = RequestTracker.getInstance();
      RequestTracker.resetInstance();
      const b = RequestTracker.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('setActiveRequest + getActiveRequestId', () => {
    it('should return requestId when set and within window', () => {
      tracker.setActiveRequest('req-1');
      expect(tracker.getActiveRequestId()).toBe('req-1');
    });

    it('should return null when no request is set', () => {
      expect(tracker.getActiveRequestId()).toBeNull();
    });

    it('should return the latest request when set multiple times', () => {
      tracker.setActiveRequest('req-1');
      tracker.setActiveRequest('req-2');
      expect(tracker.getActiveRequestId()).toBe('req-2');
    });

    it('should NOT consume the request — multiple reads return same ID', () => {
      tracker.setActiveRequest('req-1');
      expect(tracker.getActiveRequestId()).toBe('req-1');
      expect(tracker.getActiveRequestId()).toBe('req-1');
      expect(tracker.getActiveRequestId()).toBe('req-1');
    });
  });

  describe('time window expiry', () => {
    it('should return null when correlation window has elapsed', () => {
      // Use a very short window for testing
      const shortTracker = new RequestTracker(100); // 100ms
      shortTracker.setActiveRequest('req-old');

      // Simulate time passing by manipulating the internal timestamp
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(Date.now() + 200); // 200ms later

      expect(shortTracker.getActiveRequestId()).toBeNull();
    });

    it('should return requestId when within window', () => {
      const shortTracker = new RequestTracker(5000); // 5s
      shortTracker.setActiveRequest('req-fresh');

      // Only 1ms later
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(Date.now() + 1);

      expect(shortTracker.getActiveRequestId()).toBe('req-fresh');
    });

    it('should use default 5-minute window', () => {
      const defaultTracker = new RequestTracker();
      expect(defaultTracker.getCorrelationWindowMs()).toBe(5 * 60 * 1000);
    });
  });

  describe('clearOnNewMessage', () => {
    it('should clear the active request', () => {
      tracker.setActiveRequest('req-1');
      expect(tracker.getActiveRequestId()).toBe('req-1');

      tracker.clearOnNewMessage();
      expect(tracker.getActiveRequestId()).toBeNull();
    });

    it('should be safe to call when no request is active', () => {
      expect(() => tracker.clearOnNewMessage()).not.toThrow();
      expect(tracker.getActiveRequestId()).toBeNull();
    });

    it('should allow setting a new request after clearing', () => {
      tracker.setActiveRequest('req-1');
      tracker.clearOnNewMessage();
      tracker.setActiveRequest('req-2');
      expect(tracker.getActiveRequestId()).toBe('req-2');
    });
  });

  describe('correlation flow (integration)', () => {
    it('should model: message → Request → delegate → WorkItem correlation', () => {
      // 1. User message arrives → clear previous context
      tracker.clearOnNewMessage();

      // 2. Request created from message
      tracker.setActiveRequest('req-deploy-staging');

      // 3. Orchestrator delegates (possibly multiple tasks)
      expect(tracker.getActiveRequestId()).toBe('req-deploy-staging');
      expect(tracker.getActiveRequestId()).toBe('req-deploy-staging'); // second delegation

      // 4. New user message → clears context
      tracker.clearOnNewMessage();
      expect(tracker.getActiveRequestId()).toBeNull();
    });
  });
});
