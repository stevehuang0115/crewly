/**
 * Tests for TLAutoVerifyService — automatic TL verification on worker task completion.
 *
 * @module services/v3/tl-auto-verify.service.test
 */

import { TLAutoVerifyService } from './tl-auto-verify.service.js';

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

describe('TLAutoVerifyService', () => {
  beforeEach(() => {
    TLAutoVerifyService.resetInstance();
    jest.clearAllMocks();
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = TLAutoVerifyService.getInstance();
      const b = TLAutoVerifyService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('start', () => {
    it('should warn if started without initialization', () => {
      const service = TLAutoVerifyService.getInstance();
      service.start(); // should not throw
    });

    it('should subscribe to event_published', () => {
      const service = TLAutoVerifyService.getInstance();
      const mockEventBus = { on: jest.fn() };
      service.initialize(mockEventBus);
      service.start();
      expect(mockEventBus.on).toHaveBeenCalledWith('event_published', expect.any(Function));
    });
  });

  describe('findTeamLeaderForWorker', () => {
    it('should find TL via hierarchy', async () => {
      const service = TLAutoVerifyService.getInstance();
      const teams = [
        {
          id: 'team-1',
          name: 'Dev Team',
          hierarchical: true,
          members: [
            { id: 'tl-1', sessionName: 'tl-session', role: 'team-leader', hierarchyLevel: 1 },
            { id: 'worker-1', sessionName: 'worker-session', role: 'developer', parentMemberId: 'tl-1', hierarchyLevel: 2 },
          ],
        },
      ];

      service.initialize({ on: jest.fn() }, async () => teams);

      // Access private method via any cast for testing
      const result = await (service as any).findTeamLeaderForWorker('worker-session');
      expect(result).not.toBeNull();
      expect(result.tlSessionName).toBe('tl-session');
      expect(result.teamId).toBe('team-1');
    });

    it('should return null for flat teams', async () => {
      const service = TLAutoVerifyService.getInstance();
      const teams = [
        {
          id: 'team-1',
          name: 'Flat Team',
          hierarchical: false,
          members: [
            { id: 'w-1', sessionName: 'worker-session', role: 'developer' },
          ],
        },
      ];

      service.initialize({ on: jest.fn() }, async () => teams);
      const result = await (service as any).findTeamLeaderForWorker('worker-session');
      expect(result).toBeNull();
    });

    it('should return null if worker has no parent', async () => {
      const service = TLAutoVerifyService.getInstance();
      const teams = [
        {
          id: 'team-1',
          name: 'Team',
          hierarchical: true,
          members: [
            { id: 'w-1', sessionName: 'worker-session', role: 'developer' },
          ],
        },
      ];

      service.initialize({ on: jest.fn() }, async () => teams);
      const result = await (service as any).findTeamLeaderForWorker('worker-session');
      expect(result).toBeNull();
    });
  });
});
