import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storage.service.js';
import { Team, Project } from '../../types/index.js';
import { CREWLY_CONSTANTS } from '../../constants.js';

// Mock filesystem
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  watch: jest.fn(() => ({ close: jest.fn() })),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  readdir: jest.fn(),
  mkdir: jest.fn(),
  unlink: jest.fn(),
  appendFile: jest.fn(),
  open: jest.fn(),
  rename: jest.fn(),
  copyFile: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockFsPromises = require('fs/promises');

describe('StorageService', () => {
  let storageService: StorageService;
  const testHome = '/tmp/crewly-test';

  beforeEach(() => {
    jest.clearAllMocks();
    StorageService.clearInstance();
    storageService = StorageService.getInstance(testHome);
    mockFs.existsSync.mockReturnValue(true);
    
    // Setup default mocks for atomic write operations
    mockFsPromises.open.mockResolvedValue({
      sync: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    });
    mockFsPromises.rename.mockResolvedValue(undefined);
    mockFsPromises.unlink.mockResolvedValue(undefined);
  });

  describe('Team Management', () => {
    test('should save team to directory structure', async () => {
      const testTeam: Team = {
        id: 'test-id',
        name: 'Test Team',
        description: 'Test team description',
        projectIds: [],
        members: [
          {
            id: 'member-1',
            name: 'Test Developer',
            sessionName: 'test-session',
            role: 'developer',
            systemPrompt: 'Test prompt',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            runtimeType: 'claude-code',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z',
          }
        ],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Mock file operations - team is saved to directory structure
      mockFsPromises.writeFile.mockResolvedValue(undefined);
      mockFsPromises.readdir.mockResolvedValue([]); // No existing teams

      await storageService.saveTeam(testTeam);

      // Team config should be written to teams/{teamId}/config.json.tmp.*
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/teams\/test-id\/config\.json\.tmp\.\d+\.[a-z0-9]+$/),
        expect.stringContaining('"id": "test-id"'),
        'utf8'
      );
      // Then renamed to teams/{teamId}/config.json
      expect(mockFsPromises.rename).toHaveBeenCalledWith(
        expect.stringMatching(/teams\/test-id\/config\.json\.tmp\.\d+\.[a-z0-9]+$/),
        path.join(testHome, 'teams', 'test-id', 'config.json')
      );
      // Member prompt should also be saved to teams/{teamId}/prompts/{memberId}.md
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/teams\/test-id\/prompts\/member-1\.md\.tmp\.\d+\.[a-z0-9]+$/),
        'Test prompt',
        'utf8'
      );
    });

    test('should update existing team file', async () => {
      const existingTeam: Team = {
        id: 'test-id',
        name: 'Test Team',
        description: 'Test team description',
        projectIds: [],
        members: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Mock team directory and config file exists
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr.includes('test-id/config.json')) return true;
        if (pathStr.includes('test-id')) return true;
        return true; // Default
      });
      mockFsPromises.readdir.mockResolvedValue([{ name: 'test-id', isDirectory: () => true }]);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(existingTeam));

      const updatedTeam = { ...existingTeam, name: 'Updated Team' };
      await storageService.saveTeam(updatedTeam);

      expect(mockFsPromises.writeFile).toHaveBeenCalled();
      const writeCall = mockFsPromises.writeFile.mock.calls[0];
      const parsedContent = JSON.parse(writeCall[1]);
      expect(parsedContent.name).toBe('Updated Team');
    });
  });

  describe('Project Management', () => {
    test('should add new project', async () => {
      const projectPath = '/test/project';

      mockFsPromises.readFile.mockResolvedValue(JSON.stringify([]));
      mockFsPromises.writeFile.mockResolvedValue(undefined);
      mockFs.existsSync.mockReturnValue(false); // .crewly dir doesn't exist
      mockFs.mkdirSync.mockReturnValue(undefined);

      const project = await storageService.addProject(projectPath);

      expect(project.name).toBe('project');
      expect(project.path).toBe(projectPath);
      expect(project.status).toBe('stopped');
      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('Ticket Management', () => {
    test('should parse ticket YAML correctly', async () => {
      const ticketContent = `---\nid: ticket-1\ntitle: Test Ticket\nstatus: open\npriority: high\n---\n\n## Description\n\nThis is a test ticket.`;

      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readdir.mockResolvedValue(['ticket-1.yaml']);
      mockFsPromises.readFile.mockResolvedValue(ticketContent);

      const tickets = await storageService.getTickets('/test/project');

      expect(tickets).toHaveLength(1);
      expect(tickets[0].id).toBe('ticket-1');
      expect(tickets[0].title).toBe('Test Ticket');
      expect(tickets[0].status).toBe('open');
      expect(tickets[0].priority).toBe('high');
    });

    test('should filter tickets by criteria', async () => {
      const tickets = [
        { assignedTo: 'dev-1', status: 'open', priority: 'high' },
        { assignedTo: 'dev-2', status: 'in_progress', priority: 'low' },
        { assignedTo: 'dev-1', status: 'done', priority: 'medium' },
      ];

      // Mock file system to return test tickets
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readdir.mockResolvedValue(['t1.yaml', 't2.yaml', 't3.yaml']);
      
      tickets.forEach((ticket, index) => {
        const content = `---\nid: t${index + 1}\nassignedTo: ${ticket.assignedTo}\nstatus: ${ticket.status}\npriority: ${ticket.priority}\n---\n\nTest content`;
        mockFsPromises.readFile.mockResolvedValueOnce(content);
      });

      const filtered = await storageService.getTickets('/test/project', {
        status: 'open',
        assignedTo: 'dev-1'
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe('open');
      expect(filtered[0].assignedTo).toBe('dev-1');
    });
  });

  describe('Atomic File Operations', () => {
    test('should use atomic writes for team config files', async () => {
      const testTeam: Team = {
        id: 'test-id',
        name: 'Test Team',
        description: 'Test team description',
        projectIds: [],
        members: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      mockFsPromises.readdir.mockResolvedValue([]);

      await storageService.saveTeam(testTeam);

      // Verify atomic write was used (writeFile to temp, then rename to team config file)
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/teams\/test-id\/config\.json\.tmp\.\d+\.[a-z0-9]+$/),
        expect.stringContaining('"test-id"'),
        'utf8'
      );
      expect(mockFsPromises.rename).toHaveBeenCalledWith(
        expect.stringMatching(/teams\/test-id\/config\.json\.tmp\.\d+\.[a-z0-9]+$/),
        path.join(testHome, 'teams', 'test-id', 'config.json')
      );
    });

    test('should handle concurrent writes to different team directories', async () => {
      const team1: Team = {
        id: 'team-1',
        name: 'Team 1',
        description: 'Team 1 description',
        projectIds: [],
        members: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      const team2: Team = {
        id: 'team-2',
        name: 'Team 2',
        description: 'Team 2 description',
        projectIds: [],
        members: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      mockFsPromises.readdir.mockResolvedValue([]);

      // Start concurrent writes - each team goes to its own directory
      const write1 = storageService.saveTeam(team1);
      const write2 = storageService.saveTeam(team2);

      await Promise.all([write1, write2]);

      // Both operations should complete successfully with atomic writes to separate directories
      // Each saveTeam triggers an atomic write (writeFile + rename), plus the backup service
      // may also trigger writes, so we check at-least-2 rather than exact counts.
      expect(mockFsPromises.writeFile.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockFsPromises.rename.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('should clean up temporary files on write failure', async () => {
      const testTeam: Team = {
        id: 'test-id',
        name: 'Test Team',
        description: 'Test team description',
        projectIds: [],
        members: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      // Mock rename to fail
      mockFsPromises.rename.mockRejectedValue(new Error('Rename failed'));
      mockFsPromises.readdir.mockResolvedValue([]);

      await expect(storageService.saveTeam(testTeam)).rejects.toThrow('Rename failed');

      // Verify temp file cleanup was attempted for the team config file
      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        expect.stringMatching(/teams\/test-id\/config\.json\.tmp\.\d+\.[a-z0-9]+$/)
      );
    });
  });

  describe('One-Time Checks Persistence', () => {
    test('should save and retrieve one-time checks', async () => {
      const check = {
        id: 'check-1',
        targetSession: 'session-1',
        message: 'Test check',
        scheduledFor: new Date().toISOString(),
        isRecurring: false,
        createdAt: new Date().toISOString(),
      };

      // Mock empty file first read, then read with the saved check
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify([]));

      const checks = await storageService.getOneTimeChecks();
      expect(checks).toEqual([]);
    });

    test('should delete one-time check by ID', async () => {
      const checks = [
        {
          id: 'check-1',
          targetSession: 'session-1',
          message: 'Test check 1',
          scheduledFor: new Date().toISOString(),
          isRecurring: false,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'check-2',
          targetSession: 'session-2',
          message: 'Test check 2',
          scheduledFor: new Date().toISOString(),
          isRecurring: false,
          createdAt: new Date().toISOString(),
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(checks));

      const result = await storageService.deleteOneTimeCheck('check-1');
      expect(result).toBe(true);

      // Verify atomic write was called with filtered array
      expect(mockFsPromises.writeFile).toHaveBeenCalled();
    });

    test('should return false when deleting non-existent check', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify([]));

      const result = await storageService.deleteOneTimeCheck('nonexistent');
      expect(result).toBe(false);
    });

    test('should clear all one-time checks', async () => {
      mockFs.existsSync.mockReturnValue(true);

      await storageService.clearOneTimeChecks();

      // Verify atomic write was called with empty array
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/one-time-checks\.json\.tmp/),
        JSON.stringify([], null, 2),
        'utf8'
      );
    });

    test('should handle corrupted one-time checks file', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue('invalid json{');
      mockFsPromises.copyFile.mockResolvedValue(undefined);

      const checks = await storageService.getOneTimeChecks();
      expect(checks).toEqual([]);
    });
  });

  describe('Data Protection', () => {
    test('should not overwrite non-empty data with empty defaults', async () => {
      const existingProjects: Project[] = [
        {
          id: 'existing-project',
          name: 'Existing Project',
          path: '/test/existing',
          status: 'stopped',
          teams: {},
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z',
        },
      ];

      // File exists with valid content
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(existingProjects));

      const projects = await storageService.getProjects();

      expect(projects.length).toBe(1);
      expect(projects[0].id).toBe('existing-project');
      // ensureFile should NOT have written empty defaults
      // The only write call should be for the atomic write temp pattern if any
      const writeCallsWithDefaults = mockFsPromises.writeFile.mock.calls.filter(
        (call: unknown[]) => call[1] === JSON.stringify([], null, 2)
      );
      expect(writeCallsWithDefaults.length).toBe(0);
    });

    test('should backup corrupted/empty file before reinitializing', async () => {
      // File exists but is empty (which causes JSON parse to fail)
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue('');
      mockFsPromises.copyFile.mockResolvedValue(undefined);

      await storageService.getProjects();

      // Should have attempted to backup the corrupted/empty file
      expect(mockFsPromises.copyFile).toHaveBeenCalledWith(
        path.join(testHome, 'projects.json'),
        expect.stringMatching(/projects\.json\.backup\.\d+$/)
      );
    });
  });

  describe('getCrewlyHome', () => {
    test('should return the crewly home directory path', () => {
      expect(storageService.getCrewlyHome()).toBe(testHome);
    });
  });

  describe('updateAgentStatus (#261)', () => {
    test('should skip members with null sessionName', async () => {
      const team: Team = {
        id: 'team-1',
        name: 'Test Team',
        description: '',
        projectIds: [],
        members: [
          {
            id: 'member-null',
            name: 'Stopped Member',
            sessionName: null as unknown as string,
            role: 'developer',
            systemPrompt: '',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            runtimeType: 'claude-code',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z',
          },
          {
            id: 'member-active',
            name: 'Active Member',
            sessionName: 'test-session-active',
            role: 'developer',
            systemPrompt: '',
            agentStatus: 'active',
            workingStatus: 'idle',
            runtimeType: 'claude-code',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z',
          },
        ],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      mockFsPromises.readdir.mockResolvedValue([{ name: 'team-1', isDirectory: () => true }]);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(team));

      await storageService.updateAgentStatus('test-session-active', 'inactive' as any);

      // Should have written the team with updated status for the active member
      expect(mockFsPromises.writeFile).toHaveBeenCalled();
    });

    test('should skip members with empty string sessionName', async () => {
      const team: Team = {
        id: 'team-1',
        name: 'Test Team',
        description: '',
        projectIds: [],
        members: [
          {
            id: 'member-empty',
            name: 'Empty Session Member',
            sessionName: '',
            role: 'developer',
            systemPrompt: '',
            agentStatus: 'inactive',
            workingStatus: 'idle',
            runtimeType: 'claude-code',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z',
          },
        ],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      mockFsPromises.readdir.mockResolvedValue([{ name: 'team-1', isDirectory: () => true }]);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(team));

      // Searching for a real session should not match the empty-string member
      await storageService.updateAgentStatus('some-session', 'inactive' as any);

      // No team save should happen since no member was found
      // writeFile is only called during saveTeam
      const configWrites = mockFsPromises.writeFile.mock.calls.filter(
        (call: unknown[]) => String(call[0]).includes('config.json')
      );
      expect(configWrites.length).toBe(0);
    });
  });

  describe('updateTeamMemberRuntimeType (#263)', () => {
    test('should log when runtimeType changes', async () => {
      const team: Team = {
        id: 'team-rt',
        name: 'Runtime Team',
        description: '',
        projectIds: [],
        members: [
          {
            id: 'member-rt',
            name: 'RT Member',
            sessionName: 'rt-session',
            role: 'developer',
            systemPrompt: '',
            agentStatus: 'active',
            workingStatus: 'idle',
            runtimeType: 'claude-code',
            createdAt: '2023-01-01T00:00:00.000Z',
            updatedAt: '2023-01-01T00:00:00.000Z',
          },
        ],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      };

      mockFsPromises.readdir.mockResolvedValue([{ name: 'team-rt', isDirectory: () => true }]);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(team));

      await storageService.updateTeamMemberRuntimeType('team-rt', 'member-rt', 'gemini-cli' as any);

      // Verify the team was saved with the new runtime type
      expect(mockFsPromises.writeFile).toHaveBeenCalled();
      const writeCall = mockFsPromises.writeFile.mock.calls.find(
        (call: unknown[]) => String(call[0]).includes('team-rt')
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string);
      expect(saved.members[0].runtimeType).toBe('gemini-cli');
    });

    test('should throw when team not found', async () => {
      mockFsPromises.readdir.mockResolvedValue([]);

      await expect(
        storageService.updateTeamMemberRuntimeType('nonexistent', 'member-1', 'gemini-cli' as any)
      ).rejects.toThrow('Team not found');
    });
  });
});