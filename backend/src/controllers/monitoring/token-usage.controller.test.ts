/**
 * Tests for Token Usage Controller
 *
 * @module controllers/monitoring/token-usage.controller.test
 */

import { getTokenUsage, resetTokenUsage } from './token-usage.controller.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import type { Request, Response } from 'express';

describe('token-usage controller', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let jsonSpy: jest.Mock;

  beforeEach(() => {
    TokenUsageService.resetInstance();
    mockReq = {};
    jsonSpy = jest.fn();
    mockRes = { json: jsonSpy };
  });

  afterEach(() => {
    TokenUsageService.resetInstance();
  });

  describe('getTokenUsage', () => {
    it('should return empty array when no usage recorded', () => {
      getTokenUsage(mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: [],
      });
    });

    it('should return session usage summaries', () => {
      const service = TokenUsageService.getInstance();
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');

      getTokenUsage(mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: [
          expect.objectContaining({
            sessionName: 'session-1',
            agentId: 'agent-a',
            totalInput: 100,
            totalOutput: 50,
            eventCount: 1,
          }),
        ],
      });
    });
  });

  describe('resetTokenUsage', () => {
    it('should clear all usage data', () => {
      const service = TokenUsageService.getInstance();
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');

      resetTokenUsage(mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        message: 'Token usage data cleared',
      });

      // Verify data was cleared
      expect(service.getUsageBySessions()).toEqual([]);
    });
  });
});
