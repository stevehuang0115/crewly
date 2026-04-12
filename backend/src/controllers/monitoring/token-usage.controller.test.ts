/**
 * Tests for Token Usage Controller
 *
 * @module controllers/monitoring/token-usage.controller.test
 */

import { getTokenUsage, getTokenUsageByTask, resetTokenUsage, recordTokenUsage } from './token-usage.controller.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import type { Request, Response } from 'express';

describe('token-usage controller', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let jsonSpy: jest.Mock;
  let statusSpy: jest.Mock;

  beforeEach(() => {
    TokenUsageService.resetInstance();
    mockReq = { query: {}, body: {} };
    jsonSpy = jest.fn();
    statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });
    mockRes = { json: jsonSpy, status: statusSpy };
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

    it('should filter by taskId query param', () => {
      const service = TokenUsageService.getInstance();
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus', 'task-abc');
      service.recordUsage('session-1', 'agent-a', 200, 80, 'claude-opus', 'task-xyz');

      mockReq.query = { taskId: 'task-abc' };
      getTokenUsage(mockReq as Request, mockRes as Response);

      const data = jsonSpy.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].totalInput).toBe(100);
    });
  });

  describe('getTokenUsageByTask', () => {
    it('should return empty array when no usage recorded', () => {
      getTokenUsageByTask(mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        data: [],
      });
    });

    it('should return per-task aggregation', () => {
      const service = TokenUsageService.getInstance();
      service.recordUsage('s1', 'a1', 100, 50, 'claude-opus', 'task-1');
      service.recordUsage('s2', 'a2', 200, 80, 'claude-opus', 'task-1');
      service.recordUsage('s1', 'a1', 300, 120, 'claude-opus', 'task-2');

      getTokenUsageByTask(mockReq as Request, mockRes as Response);

      const data = jsonSpy.mock.calls[0][0].data;
      expect(data.length).toBe(2);
      const task1 = data.find((t: { taskId: string }) => t.taskId === 'task-1');
      expect(task1.totalInput).toBe(300);
      expect(task1.totalOutput).toBe(130);
      expect(task1.eventCount).toBe(2);
    });
  });

  describe('recordTokenUsage', () => {
    it('should record usage when all fields provided', () => {
      mockReq.body = {
        sessionName: 's1',
        agentId: 'a1',
        input: 500,
        output: 200,
        model: 'claude-opus',
        taskId: 'task-1',
      };

      recordTokenUsage(mockReq as Request, mockRes as Response);

      expect(jsonSpy).toHaveBeenCalledWith({
        success: true,
        message: 'Token usage recorded',
      });

      const service = TokenUsageService.getInstance();
      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].totalInput).toBe(500);
    });

    it('should return 400 when required fields are missing', () => {
      mockReq.body = { sessionName: 's1' }; // missing other fields

      recordTokenUsage(mockReq as Request, mockRes as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
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
