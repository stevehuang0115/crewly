/**
 * Tests for require-auth middleware (#274)
 *
 * @module middleware/require-auth.test
 */

// Mock logger before importing middleware
jest.mock('../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: jest.fn().mockReturnValue({
      createComponentLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('requireAuth', () => {
  let mockReq: any;
  let mockRes: any;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      headers: {},
      path: '/test',
      method: 'GET',
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  describe('with auth disabled (default)', () => {
    beforeEach(() => {
      // Default: CREWLY_AUTH_DISABLED is not 'false', so auth is disabled
      delete process.env['CREWLY_AUTH_DISABLED'];
      jest.resetModules();
    });

    it('should call next() without any headers (auth bypassed)', async () => {
      const { requireAuth } = await import('./require-auth.middleware.js');
      requireAuth(mockReq, mockRes, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe('with auth enabled (CREWLY_AUTH_DISABLED=false)', () => {
    beforeEach(() => {
      process.env['CREWLY_AUTH_DISABLED'] = 'false';
      delete process.env['CREWLY_API_KEY'];
      jest.resetModules();
    });

    afterEach(() => {
      delete process.env['CREWLY_AUTH_DISABLED'];
      delete process.env['CREWLY_API_KEY'];
    });

    it('should return 401 when no auth headers provided', async () => {
      const { requireAuth } = await import('./require-auth.middleware.js');
      requireAuth(mockReq, mockRes, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    it('should allow requests with X-Agent-Session header', async () => {
      const { requireAuth } = await import('./require-auth.middleware.js');
      mockReq.headers['x-agent-session'] = 'crewly-orc';
      requireAuth(mockReq, mockRes, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should reject empty X-Agent-Session header', async () => {
      const { requireAuth } = await import('./require-auth.middleware.js');
      mockReq.headers['x-agent-session'] = '';
      requireAuth(mockReq, mockRes, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('should reject invalid Bearer token when CREWLY_API_KEY is set', async () => {
      process.env['CREWLY_API_KEY'] = 'valid-secret-key';
      jest.resetModules();
      const { requireAuth } = await import('./require-auth.middleware.js');
      mockReq.headers['authorization'] = 'Bearer wrong-key';
      requireAuth(mockReq, mockRes, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('should allow valid Bearer token matching CREWLY_API_KEY', async () => {
      process.env['CREWLY_API_KEY'] = 'valid-secret-key';
      jest.resetModules();
      const { requireAuth } = await import('./require-auth.middleware.js');
      mockReq.headers['authorization'] = 'Bearer valid-secret-key';
      requireAuth(mockReq, mockRes, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should reject Bearer token when no CREWLY_API_KEY configured', async () => {
      jest.resetModules();
      const { requireAuth } = await import('./require-auth.middleware.js');
      mockReq.headers['authorization'] = 'Bearer some-token';
      requireAuth(mockReq, mockRes, next);
      expect(next).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });
  });
});
