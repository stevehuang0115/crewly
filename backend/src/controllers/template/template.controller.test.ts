/**
 * Tests for Template Controller
 *
 * Validates the REST handlers for template endpoints including
 * list, get, create-team, filtering, and error handling.
 *
 * @module controllers/template/template.controller.test
 */

import {
  handleListTemplates,
  handleGetTemplate,
  handleCreateTeamFromTemplate,
  handleDeployTemplate,
} from './template.controller.js';

// Mock TemplateService
const mockListTemplates = jest.fn();
const mockGetTemplate = jest.fn();
const mockCreateTeamFromTemplate = jest.fn();

jest.mock('../../services/template/template.service.js', () => ({
  TemplateService: {
    getInstance: () => ({
      listTemplates: mockListTemplates,
      getTemplate: mockGetTemplate,
      createTeamFromTemplate: mockCreateTeamFromTemplate,
    }),
  },
}));

// Mock CloudClientService for tier resolution
const mockGetTier = jest.fn().mockReturnValue('free');

jest.mock('../../services/cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      getTier: mockGetTier,
    }),
  },
}));

// Mock SkillTierService for tier comparison
const mockIsTierSufficient = jest.fn().mockReturnValue(true);

jest.mock('../../services/skill/skill-tier.service.js', () => ({
  SkillTierService: {
    getInstance: () => ({
      isTierSufficient: mockIsTierSufficient,
    }),
  },
}));

// Mock StorageService for deploy handler
const mockSaveTeam = jest.fn().mockResolvedValue(undefined);

jest.mock('../../services/core/storage.service.js', () => ({
  StorageService: {
    getInstance: () => ({
      saveTeam: mockSaveTeam,
    }),
  },
}));

// =============================================================================
// Helpers
// =============================================================================

function createMockRes() {
  const res: Record<string, jest.Mock> = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  };
  return res;
}

function createMockReq(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

const sampleSummary = {
  id: 'dev-fullstack',
  name: 'Fullstack Dev Team',
  description: 'TL + 2 developers',
  category: 'development',
  hierarchical: true,
  roleCount: 2,
  version: '1.0.0',
};

const sampleTemplate = {
  id: 'dev-fullstack',
  name: 'Fullstack Dev Team',
  description: 'TL + 2 developers',
  category: 'development',
  version: '1.0.0',
  hierarchical: true,
  roles: [
    { role: 'team-leader', label: 'TL', defaultName: 'Lead', count: 1, hierarchyLevel: 1, canDelegate: true, defaultSkills: [] },
    { role: 'developer', label: 'Dev', defaultName: 'Dev', count: 2, hierarchyLevel: 2, canDelegate: false, defaultSkills: [] },
  ],
  defaultRuntime: 'claude-code',
  verificationPipeline: { name: 'Dev Pipeline', steps: [], passPolicy: 'all', maxRetries: 2 },
};

const sampleCreateResult = {
  team: { id: 'team-1', name: 'My Team', members: [], hierarchical: true },
  templateId: 'dev-fullstack',
  memberCount: 3,
};

// =============================================================================
// Tests
// =============================================================================

describe('TemplateController', () => {
  let mockRes: ReturnType<typeof createMockRes>;
  const next = jest.fn();

  beforeEach(() => {
    mockRes = createMockRes();
    next.mockReset();
    mockListTemplates.mockReset();
    mockGetTemplate.mockReset();
    mockCreateTeamFromTemplate.mockReset();
    mockIsTierSufficient.mockReset();
    mockGetTier.mockReset().mockReturnValue('free');
    mockSaveTeam.mockReset().mockResolvedValue(undefined);
  });

  // ========================= handleListTemplates =========================

  describe('handleListTemplates', () => {
    it('should return all templates with accessible annotation', async () => {
      mockListTemplates.mockReturnValue([sampleSummary]);
      mockIsTierSufficient.mockReturnValue(true);

      const req = createMockReq();
      await handleListTemplates(req as any, mockRes as any, next);

      const data = mockRes.json.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].accessible).toBe(true);
    });

    it('should mark pro templates as inaccessible for free users', async () => {
      const proTemplate = { ...sampleSummary, requiredTier: 'pro' };
      mockListTemplates.mockReturnValue([proTemplate]);
      mockIsTierSufficient.mockReturnValue(false);
      mockGetTier.mockReturnValue('free');

      const req = createMockReq();
      await handleListTemplates(req as any, mockRes as any, next);

      const data = mockRes.json.mock.calls[0][0].data;
      expect(data[0].accessible).toBe(false);
    });

    it('should mark pro templates as accessible for pro users', async () => {
      const proTemplate = { ...sampleSummary, requiredTier: 'pro' };
      mockListTemplates.mockReturnValue([proTemplate]);
      mockIsTierSufficient.mockReturnValue(true);
      mockGetTier.mockReturnValue('pro');

      const req = createMockReq();
      await handleListTemplates(req as any, mockRes as any, next);

      const data = mockRes.json.mock.calls[0][0].data;
      expect(data[0].accessible).toBe(true);
    });

    it('should return empty array when no templates exist', async () => {
      mockListTemplates.mockReturnValue([]);

      const req = createMockReq();
      await handleListTemplates(req as any, mockRes as any, next);

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: [],
      });
    });

    it('should filter by category when provided', async () => {
      const devTemplate = { ...sampleSummary, category: 'development' };
      const contentTemplate = { ...sampleSummary, id: 'blog-team', category: 'content' };
      mockListTemplates.mockReturnValue([devTemplate, contentTemplate]);
      mockIsTierSufficient.mockReturnValue(true);

      const req = createMockReq({ query: { category: 'development' } });
      await handleListTemplates(req as any, mockRes as any, next);

      const data = mockRes.json.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('dev-fullstack');
    });

    it('should return empty array when category filter matches nothing', async () => {
      mockListTemplates.mockReturnValue([sampleSummary]);

      const req = createMockReq({ query: { category: 'research' } });
      await handleListTemplates(req as any, mockRes as any, next);

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: [],
      });
    });

    it('should return 500 when service throws', async () => {
      mockListTemplates.mockImplementation(() => { throw new Error('Load failed'); });

      const req = createMockReq();
      await handleListTemplates(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Load failed',
      });
    });
  });

  // ========================= handleGetTemplate =========================

  describe('handleGetTemplate', () => {
    it('should return template by ID', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);

      const req = createMockReq({ params: { id: 'dev-fullstack' } });
      await handleGetTemplate(req as any, mockRes as any, next);

      expect(mockGetTemplate).toHaveBeenCalledWith('dev-fullstack');
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: sampleTemplate,
      });
    });

    it('should return 404 when template not found', async () => {
      mockGetTemplate.mockReturnValue(null);

      const req = createMockReq({ params: { id: 'nonexistent' } });
      await handleGetTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Template "nonexistent" not found',
      });
    });

    it('should return 500 when service throws', async () => {
      mockGetTemplate.mockImplementation(() => { throw new Error('Read failed'); });

      const req = createMockReq({ params: { id: 'dev-fullstack' } });
      await handleGetTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Read failed',
      });
    });
  });

  // ========================= handleCreateTeamFromTemplate =========================

  describe('handleCreateTeamFromTemplate', () => {
    it('should create team from template', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCreateTeamFromTemplate.mockReturnValue(sampleCreateResult);

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 'My Team' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith('dev-fullstack', 'My Team', undefined, 'free');
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: sampleCreateResult,
      });
    });

    it('should pass name overrides when provided', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCreateTeamFromTemplate.mockReturnValue(sampleCreateResult);

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 'My Team', nameOverrides: { 'team-leader': 'Alice' } },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith(
        'dev-fullstack',
        'My Team',
        { 'team-leader': 'Alice' },
        'free',
      );
    });

    it('should trim teamName', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCreateTeamFromTemplate.mockReturnValue(sampleCreateResult);

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: '  My Team  ' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith('dev-fullstack', 'My Team', undefined, 'free');
    });

    it('should return 400 when teamName is missing', async () => {
      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: {},
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'teamName is required and must be a non-empty string',
      });
    });

    it('should return 400 when teamName is empty string', async () => {
      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: '   ' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when teamName is not a string', async () => {
      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 123 },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 when template not found', async () => {
      mockGetTemplate.mockReturnValue(null);

      const req = createMockReq({
        params: { id: 'nonexistent' },
        body: { teamName: 'My Team' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Template "nonexistent" not found',
      });
    });

    it('should return 500 when service throws generic error', async () => {
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCreateTeamFromTemplate.mockImplementation(() => { throw new Error('Create failed'); });

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 'My Team' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Create failed',
      });
    });

    it('should return 403 when tier is insufficient', async () => {
      const proTemplate = { ...sampleTemplate, requiredTier: 'pro' };
      mockGetTemplate.mockReturnValue(proTemplate);
      mockIsTierSufficient.mockReturnValue(false);

      const req = createMockReq({
        params: { id: 'pro-dev' },
        body: { teamName: 'My Team' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('requires pro plan'),
      });
      expect(mockCreateTeamFromTemplate).not.toHaveBeenCalled();
    });

    it('should pass pro tier to service when user is pro', async () => {
      mockGetTier.mockReturnValue('pro');
      mockGetTemplate.mockReturnValue(sampleTemplate);
      mockCreateTeamFromTemplate.mockReturnValue(sampleCreateResult);

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 'My Team' },
      });
      await handleCreateTeamFromTemplate(req as any, mockRes as any, next);

      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith('dev-fullstack', 'My Team', undefined, 'pro');
    });
  });

  // ========================= handleDeployTemplate =========================

  describe('handleDeployTemplate', () => {
    it('should deploy template and save to storage', async () => {
      mockCreateTeamFromTemplate.mockReturnValue(sampleCreateResult);
      mockGetTemplate.mockReturnValue(sampleTemplate);

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 'Deploy Team' },
      });
      await handleDeployTemplate(req as any, mockRes as any, next);

      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith('dev-fullstack', 'Deploy Team', undefined, 'free');
      expect(mockSaveTeam).toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(201);
      const data = mockRes.json.mock.calls[0][0].data;
      expect(data.deployed).toBe(true);
    });

    it('should return 400 when teamName is missing', async () => {
      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: {},
      });
      await handleDeployTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 when template not found', async () => {
      mockGetTemplate.mockReturnValue(null);

      const req = createMockReq({
        params: { id: 'nonexistent' },
        body: { teamName: 'Team' },
      });
      await handleDeployTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should return 403 when tier is insufficient for deploy', async () => {
      const proTemplate = { ...sampleTemplate, requiredTier: 'pro' };
      mockGetTemplate.mockReturnValue(proTemplate);
      mockIsTierSufficient.mockReturnValue(false);

      const req = createMockReq({
        params: { id: 'pro-dev' },
        body: { teamName: 'Team' },
      });
      await handleDeployTemplate(req as any, mockRes as any, next);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockCreateTeamFromTemplate).not.toHaveBeenCalled();
    });

    it('should assign projectId when provided', async () => {
      const teamResult = {
        ...sampleCreateResult,
        team: { ...sampleCreateResult.team, members: [{ id: 'a', name: 'Lead', role: 'team-leader' }] },
      };
      mockCreateTeamFromTemplate.mockReturnValue(teamResult);
      mockGetTemplate.mockReturnValue(sampleTemplate);

      const req = createMockReq({
        params: { id: 'dev-fullstack' },
        body: { teamName: 'Team', projectId: 'proj-123' },
      });
      await handleDeployTemplate(req as any, mockRes as any, next);

      const savedTeam = mockSaveTeam.mock.calls[0][0];
      expect(savedTeam.projectIds).toEqual(['proj-123']);
    });
  });
});
