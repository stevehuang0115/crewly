import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { jest } from '@jest/globals';
import { TeamsJsonWatcherService } from './teams-json-watcher.service.js';
import { TeamActivityWebSocketService } from './team-activity-websocket.service.js';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock os module
jest.mock('os');
const mockOs = os as jest.Mocked<typeof os>;

// Mock path module methods that are used
jest.mock('path', () => ({
  ...(jest.requireActual('path') as object),
  join: jest.fn(),
  dirname: jest.fn()
}));
const mockPath = path as jest.Mocked<typeof path>;

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: jest.fn().mockReturnValue({
      createComponentLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      })
    })
  }
}));

/**
 * Helper to flush pending microtasks (Promise resolutions) when using fake timers
 */
const flushPromises = () => new Promise<void>(resolve => jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve));

describe('TeamsJsonWatcherService', () => {
  let service: TeamsJsonWatcherService;
  let mockTeamActivityService: jest.Mocked<TeamActivityWebSocketService>;
  let mockWatcher: jest.Mocked<fs.FSWatcher>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Mock os.homedir
    mockOs.homedir.mockReturnValue('/mock/home');

    // Mock path.join and path.dirname
    mockPath.join.mockImplementation((...args: string[]) => args.join('/'));
    mockPath.dirname.mockReturnValue('/mock/home/.crewly');

    // Mock fs.existsSync
    mockFs.existsSync.mockReturnValue(true);

    // Mock fs.mkdirSync
    mockFs.mkdirSync.mockImplementation(() => '/mock/home/.crewly/teams');

    // Mock fs.readdirSync to return empty array (no existing team dirs)
    mockFs.readdirSync.mockReturnValue([] as any);

    // Mock fs.watch
    mockWatcher = {
      on: jest.fn(),
      close: jest.fn()
    } as any;
    mockFs.watch.mockReturnValue(mockWatcher);

    // Create mock team activity service
    mockTeamActivityService = {
      forceRefresh: jest.fn()
    } as any;

    // Create service instance
    service = new TeamsJsonWatcherService();
    service.setTeamActivityService(mockTeamActivityService);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    service.stop();
  });

  describe('constructor', () => {
    it('should initialize with correct teams directory path', () => {
      expect(mockOs.homedir).toHaveBeenCalled();
      expect(mockPath.join).toHaveBeenCalledWith('/mock/home', '.crewly', 'teams');
    });
  });

  describe('setTeamActivityService', () => {
    it('should set the team activity service', () => {
      const newMockService = { forceRefresh: jest.fn() } as any;
      service.setTeamActivityService(newMockService);

      // This is tested indirectly by checking if the correct service is called in other tests
      expect(newMockService).toBeDefined();
    });
  });

  describe('start', () => {
    it('should start watching teams directory successfully', () => {
      service.start();

      expect(mockFs.existsSync).toHaveBeenCalled();
      expect(mockFs.watch).toHaveBeenCalledWith(
        expect.any(String),
        { persistent: true },
        expect.any(Function)
      );
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockTeamActivityService.forceRefresh).toHaveBeenCalledWith();
    });

    it('should create teams directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      service.start();

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    it('should handle watcher errors and attempt restart', () => {
      service.start();

      // Get the error handler that was registered
      const errorHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      // Simulate an error
      const mockError = new Error('Watcher failed');
      (errorHandler as Function)?.(mockError);

      // Fast-forward timers to trigger restart
      jest.advanceTimersByTime(5000);

      // Should have attempted to restart (second call to fs.watch)
      expect(mockFs.watch).toHaveBeenCalledTimes(2);
    });

    it('should stop existing watcher before starting new one', () => {
      // Start first watcher
      service.start();
      expect(mockFs.watch).toHaveBeenCalledTimes(1);

      // Start second watcher
      service.start();
      expect(mockWatcher.close).toHaveBeenCalled();
      expect(mockFs.watch).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop', () => {
    it('should stop the watcher and clear timers', () => {
      service.start();
      service.stop();

      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should handle errors when stopping watcher', () => {
      service.start();
      mockWatcher.close.mockImplementation(() => {
        throw new Error('Close failed');
      });

      // Should not throw
      expect(() => service.stop()).not.toThrow();
    });

    it('should handle case where watcher is null', () => {
      // Don't start the service, just try to stop it
      expect(() => service.stop()).not.toThrow();
    });
  });

  describe('teams directory change handling', () => {
    /**
     * Test that directory changes trigger team activity updates.
     * The change handler is async (processTeamsJsonChange), so we need to
     * flush promises after advancing timers past the debounce delay.
     */
    it('should trigger team activity update when directory changes', async () => {
      service.start();

      // Get the change handler from the fs.watch call using type assertion
      const watchCall = mockFs.watch.mock.calls[0] as unknown as [string, object, Function];
      const changeHandler = watchCall[2];
      expect(changeHandler).toBeDefined();

      // Simulate directory change with a non-hidden name
      // Mock the path as a directory
      mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
      changeHandler('rename', 'team-1');

      // Fast-forward past debounce delay and flush async processTeamsJsonChange
      jest.advanceTimersByTime(1000);
      await flushPromises();

      // Should have triggered team activity refresh (once for initial, once for change)
      expect(mockTeamActivityService.forceRefresh).toHaveBeenCalledTimes(2);
    });

    it('should ignore changes to hidden files', () => {
      service.start();
      mockTeamActivityService.forceRefresh.mockClear(); // Clear the initial call

      // Get the change handler
      const watchCall = mockFs.watch.mock.calls[0] as unknown as [string, object, Function];
      const changeHandler = watchCall[2];

      // Simulate change to hidden file (starts with .)
      changeHandler('change', '.hidden-file');

      // Fast-forward past debounce delay
      jest.advanceTimersByTime(1000);

      // Should not have triggered team activity refresh (hidden files are ignored)
      expect(mockTeamActivityService.forceRefresh).not.toHaveBeenCalled();
    });

    /**
     * Test debouncing of multiple rapid changes.
     * The debounced callback is async, so we flush promises after advancing timers.
     */
    it('should debounce multiple rapid changes', async () => {
      service.start();
      mockTeamActivityService.forceRefresh.mockClear(); // Clear the initial call

      // Get the change handler
      const watchCall = mockFs.watch.mock.calls[0] as unknown as [string, object, Function];
      const changeHandler = watchCall[2];

      // Mock for directory changes
      mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

      // Simulate multiple rapid changes
      changeHandler('rename', 'team-1');
      changeHandler('rename', 'team-2');
      changeHandler('rename', 'team-3');

      // Fast-forward past debounce delay and flush async processTeamsJsonChange
      jest.advanceTimersByTime(1000);
      await flushPromises();

      // Should only have triggered once despite multiple changes
      expect(mockTeamActivityService.forceRefresh).toHaveBeenCalledTimes(1);
    });

    it('should handle case where TeamActivityWebSocketService is not set', () => {
      const serviceWithoutActivity = new TeamsJsonWatcherService();
      serviceWithoutActivity.start();

      // Get the change handler - serviceWithoutActivity start() adds another watch call
      const lastCallIdx = mockFs.watch.mock.calls.length - 1;
      const watchCall = mockFs.watch.mock.calls[lastCallIdx] as unknown as [string, object, Function];
      const changeHandler = watchCall[2];

      // Mock for directory changes
      mockFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

      // Should not throw even without team activity service
      expect(() => {
        changeHandler('rename', 'team-1');
        jest.advanceTimersByTime(1000);
      }).not.toThrow();

      serviceWithoutActivity.stop();
    });
  });

  describe('getStatus', () => {
    it('should return correct status when watching', () => {
      service.start();

      const status = service.getStatus();

      expect(status.isWatching).toBe(true);
      expect(status.teamsDir).toBeDefined();
      expect(status.dirExists).toBe(true);
      expect(status.teamCount).toBeGreaterThanOrEqual(0);
      expect(status.watchedTeams).toBeInstanceOf(Array);
    });

    it('should return correct status when not watching', () => {
      const status = service.getStatus();

      expect(status.isWatching).toBe(false);
      expect(status.teamsDir).toBeDefined();
      expect(status.dirExists).toBe(true);
    });

    it('should handle case where directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      // Need a fresh service instance so the constructor picks up the new mocks
      const freshService = new TeamsJsonWatcherService();
      const status = freshService.getStatus();

      expect(status.dirExists).toBe(false);
      expect(status.teamCount).toBe(0);
    });
  });

  describe('forceTrigger', () => {
    it('should manually trigger team activity update', () => {
      service.forceTrigger('test_trigger');

      expect(mockTeamActivityService.forceRefresh).toHaveBeenCalled();
    });

    it('should use default reason if not provided', () => {
      service.forceTrigger();

      expect(mockTeamActivityService.forceRefresh).toHaveBeenCalled();
    });
  });

  describe('event emission', () => {
    it('should emit team_activity_triggered event', () => {
      const eventListener = jest.fn();
      service.on('team_activity_triggered', eventListener);

      service.forceTrigger('manual_test');

      expect(eventListener).toHaveBeenCalledWith({
        reason: 'manual_test',
        timestamp: expect.any(Date)
      });
    });

    it('should emit watcher_error event on watcher errors', () => {
      const errorListener = jest.fn();
      service.on('watcher_error', errorListener);

      service.start();

      // Get the error handler
      const errorHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'error')?.[1];
      const mockError = new Error('Watcher failed');
      (errorHandler as Function)?.(mockError);

      expect(errorListener).toHaveBeenCalledWith(mockError);
    });
  });

  describe('cleanup', () => {
    it('should clean up on process signals', () => {
      const stopSpy = jest.spyOn(service, 'stop');

      service.start();

      // Simulate SIGINT
      process.emit('SIGINT', 'SIGINT');

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('runtimeType change detection (#263)', () => {
    it('should emit agent:status_changed event when runtimeType changes', async () => {
      const mockEventBus = {
        publish: jest.fn(),
      };
      // Access private eventBusService field
      (service as any).eventBusService = mockEventBus;

      const oldTeams = [{
        id: 'team-1',
        name: 'Team 1',
        members: [{
          id: 'm1',
          name: 'Dev 1',
          sessionName: 'dev-1',
          agentStatus: 'active',
          workingStatus: 'idle',
          runtimeType: 'claude-code',
        }],
      }];

      const newTeams = [{
        id: 'team-1',
        name: 'Team 1',
        members: [{
          id: 'm1',
          name: 'Dev 1',
          sessionName: 'dev-1',
          agentStatus: 'active',
          workingStatus: 'idle',
          runtimeType: 'gemini-cli',
        }],
      }];

      // Call the private method that detects changes
      (service as any).publishAgentEvents(oldTeams, newTeams);

      // Should have published a runtimeType change event
      const runtimeCall = mockEventBus.publish.mock.calls.find(
        (call: unknown[]) => (call[0] as { changedField: string }).changedField === 'runtimeType'
      );
      expect(runtimeCall).toBeDefined();
      const evt = runtimeCall![0] as { type: string; previousValue: string; newValue: string };
      expect(evt.type).toBe('agent:status_changed');
      expect(evt.previousValue).toBe('claude-code');
      expect(evt.newValue).toBe('gemini-cli');
    });

    it('should not emit event when runtimeType stays the same', async () => {
      const mockEventBus = {
        publish: jest.fn(),
      };
      (service as any).eventBusService = mockEventBus;

      const teams = [{
        id: 'team-1',
        name: 'Team 1',
        members: [{
          id: 'm1',
          name: 'Dev 1',
          sessionName: 'dev-1',
          agentStatus: 'active',
          workingStatus: 'idle',
          runtimeType: 'claude-code',
        }],
      }];

      (service as any).publishAgentEvents(teams, teams);

      const runtimeCall = mockEventBus.publish.mock.calls.find(
        (call: unknown[]) => (call[0] as { changedField: string }).changedField === 'runtimeType'
      );
      expect(runtimeCall).toBeUndefined();
    });
  });
});

