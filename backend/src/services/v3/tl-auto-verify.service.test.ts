/**
 * Tests for TLAutoVerifyService — automatic TL verification on worker task completion.
 *
 * @module services/v3/tl-auto-verify.service.test
 */

import { TLAutoVerifyService } from './tl-auto-verify.service.js';

const mockEnqueue = jest.fn();
const mockAxiosPost = jest.fn();

jest.mock('../messaging/message-queue.service.js', () => ({
  MessageQueueService: jest.fn().mockImplementation(() => ({ enqueue: mockEnqueue })),
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockAxiosPost(...args), get: jest.fn() },
}));

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

describe('TLAutoVerifyService delivery routing', () => {
  const hierarchicalTeams = [
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

  beforeEach(() => {
    TLAutoVerifyService.resetInstance();
    jest.clearAllMocks();
    mockEnqueue.mockReset();
    mockAxiosPost.mockReset();
  });

  it('delivers the [AUTO-VERIFY] instruction directly to the TL terminal, not the orchestrator queue', async () => {
    mockAxiosPost.mockResolvedValue({ status: 200, data: {} });
    const service = TLAutoVerifyService.getInstance();
    service.initialize({ on: jest.fn() }, async () => hierarchicalTeams);

    await (service as any).onWorkerTaskCompleted('worker-session', 'team-1', 'task-42');

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockAxiosPost.mock.calls[0];
    expect(url).toBe('http://localhost:8787/api/terminal/tl-session/write');
    expect(body).toEqual({ data: expect.stringContaining('[AUTO-VERIFY] Worker worker-session'), mode: 'message' });
    expect(body.data).toContain('Task ID: task-42');
    expect(opts.headers['X-Agent-Session']).toBeDefined();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('falls back to the orchestrator queue when the TL terminal write fails', async () => {
    mockAxiosPost.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    const service = TLAutoVerifyService.getInstance();
    service.initialize({ on: jest.fn() }, async () => hierarchicalTeams);

    await (service as any).onWorkerTaskCompleted('worker-session', 'team-1', 'task-42');

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][0]).toMatchObject({
      source: 'system_event',
      sourceMetadata: { type: 'auto-verify', workerSession: 'worker-session', taskId: 'task-42' },
    });
    expect(mockEnqueue.mock.calls[0][0].content).toContain('[AUTO-VERIFY] Worker worker-session');
  });

  it('uses the orchestrator queue directly when the TL is the orchestrator itself', async () => {
    const teams = [
      {
        id: 'team-1',
        name: 'Orc-led',
        hierarchical: true,
        members: [
          { id: 'orc', sessionName: 'crewly-orc', role: 'orchestrator', hierarchyLevel: 1 },
          { id: 'worker-1', sessionName: 'worker-session', role: 'developer', parentMemberId: 'orc', hierarchyLevel: 2 },
        ],
      },
    ];
    const service = TLAutoVerifyService.getInstance();
    service.initialize({ on: jest.fn() }, async () => teams);

    await (service as any).onWorkerTaskCompleted('worker-session', 'team-1', 'task-42');

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});
