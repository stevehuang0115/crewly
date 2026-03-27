/**
 * Tests for Token Estimation Engine
 *
 * Covers deployment quotes, task token estimation, complexity classification,
 * historical calibration, and template loading.
 *
 * @module services/monitoring/token-estimator.service.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TokenEstimatorService } from './token-estimator.service.js';
import type { TaskComplexity, TemplateInfo } from './token-estimator.service.js';
import fs from 'fs/promises';

// Mock fs
jest.mock('fs/promises');

const mockedFs = fs as jest.Mocked<typeof fs>;

// ── Test Fixtures ────────────────────────────────────────────────────────────

const mockManifest = {
  templates: [
    {
      templateId: 'test-template',
      displayName: 'Test Template',
      agentCount: 2,
      estimatedTokenUsage: {
        perTaskAvg: 100000,
        dailyBudget: 1000000,
        modelBreakdown: {
          'claude-3-5-sonnet': 100,
        },
      },
    },
  ],
};

const mockDirectoryTemplate = {
  id: 'dev-fullstack',
  name: 'Fullstack Development Team',
  roles: [
    {
      role: 'team-leader',
      label: 'Tech Lead',
      count: 1,
      defaultTools: [
        'delegate_task', 'send_message', 'get_team_status',
        'report_status', 'bash_exec', 'read_file', 'write_file',
        'edit_file', 'glob', 'grep',
      ],
      modelConfig: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        temperature: 0.3,
      },
    },
    {
      role: 'developer',
      label: 'Developer',
      count: 2,
      defaultTools: [
        'report_status', 'send_message', 'bash_exec',
        'read_file', 'write_file', 'edit_file', 'glob', 'grep',
      ],
      modelConfig: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        temperature: 0.2,
      },
    },
  ],
};

const mockFileTemplate = {
  id: 'simple-team',
  name: 'Simple Team',
  members: [
    {
      name: 'Worker',
      role: 'worker',
      count: 1,
      tools: ['bash_exec', 'read_file'],
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TokenEstimatorService', () => {
  let service: TokenEstimatorService;

  beforeEach(() => {
    TokenEstimatorService.resetInstance();
    service = new TokenEstimatorService('/mock/project');
    jest.clearAllMocks();
  });

  // ── Singleton ──────────────────────────────────────────────────────────

  describe('singleton', () => {
    it('should return the same instance', () => {
      TokenEstimatorService.resetInstance();
      const a = TokenEstimatorService.getInstance('/test');
      const b = TokenEstimatorService.getInstance('/other');
      expect(a).toBe(b);
    });

    it('should reset cleanly', () => {
      const a = TokenEstimatorService.getInstance('/test');
      TokenEstimatorService.resetInstance();
      const b = TokenEstimatorService.getInstance('/test2');
      expect(a).not.toBe(b);
    });
  });

  // ── Deployment Quotes (existing) ───────────────────────────────────────

  describe('getQuote', () => {
    beforeEach(() => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
    });

    it('should calculate a correct quote for a template', async () => {
      const quote = await service.getQuote('test-template');

      expect(quote.templateId).toBe('test-template');
      expect(quote.templateName).toBe('Test Template');
      expect(quote.agentCount).toBe(2);

      // claude-3-5-sonnet: input=0.000003, output=0.000015
      // Blended rate (1M): (3 + 15) * 0.5 = 9.0 USD
      expect(quote.estimatedCostPerTask).toBe(0.9);
      expect(quote.estimatedDailyBudget).toBe(9.0);
      expect(quote.totalEstimatedCost).toBe(10.35);
      expect(quote.serviceFee).toBe(1.35);
      expect(quote.currency).toBe('USD');
    });

    it('should throw error if template is not found', async () => {
      await expect(service.getQuote('non-existent'))
        .rejects.toThrow('Template not found: non-existent');
    });

    it('should calculate quotes for all templates', async () => {
      const quotes = await service.getAllQuotes();
      expect(quotes.length).toBe(1);
      expect(quotes[0].templateId).toBe('test-template');
    });
  });

  // ── Template Loading ───────────────────────────────────────────────────

  describe('loadTemplate', () => {
    it('should load a directory-based template', async () => {
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(mockDirectoryTemplate));

      const template = await service.loadTemplate('dev-fullstack');

      expect(template.id).toBe('dev-fullstack');
      expect(template.name).toBe('Fullstack Development Team');
      expect(template.roles).toHaveLength(2);
      expect(template.roles[0].role).toBe('team-leader');
      expect(template.roles[0].count).toBe(1);
      expect(template.roles[1].role).toBe('developer');
      expect(template.roles[1].count).toBe(2);
    });

    it('should fall back to file-based template', async () => {
      // First call (directory) fails, second call (file) succeeds
      mockedFs.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(JSON.stringify(mockFileTemplate));

      const template = await service.loadTemplate('simple-team');

      expect(template.id).toBe('simple-team');
      expect(template.roles).toHaveLength(1);
      expect(template.roles[0].role).toBe('worker');
    });

    it('should throw if template not found in either location', async () => {
      mockedFs.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'));

      await expect(service.loadTemplate('nonexistent'))
        .rejects.toThrow('Template not found: nonexistent');
    });

    it('should handle templates with members array (file-based format)', async () => {
      mockedFs.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(JSON.stringify(mockFileTemplate));

      const template = await service.loadTemplate('simple-team');
      expect(template.roles[0].defaultTools).toEqual(['bash_exec', 'read_file']);
    });
  });

  // ── Complexity Classification ──────────────────────────────────────────

  describe('classifyComplexity', () => {
    it('should classify short simple tasks as simple', () => {
      expect(service.classifyComplexity('fix typo in readme')).toBe('simple');
    });

    it('should classify short tasks without keywords as simple', () => {
      expect(service.classifyComplexity('add a button')).toBe('simple');
    });

    it('should classify medium-length tasks as moderate', () => {
      const objective = 'Create a new component that displays user profiles with avatar images and status indicators in a grid layout';
      expect(service.classifyComplexity(objective)).toBe('moderate');
    });

    it('should classify tasks with complex keywords as complex', () => {
      expect(service.classifyComplexity('refactor the authentication system to use OAuth2')).toBe('complex');
    });

    it('should classify long tasks with complex keywords as very_complex', () => {
      const objective = 'Redesign the entire microservice architecture to support multi-region deployment with database schema migration and full security audit of all API endpoints including CI/CD pipeline updates and performance optimization across all services';
      expect(service.classifyComplexity(objective)).toBe('very_complex');
    });

    it('should prefer simple keywords over complex when task is short', () => {
      expect(service.classifyComplexity('fix typo')).toBe('simple');
    });

    it('should classify deploy-related tasks as complex', () => {
      expect(service.classifyComplexity('set up deploy pipeline for staging')).toBe('complex');
    });
  });

  // ── System Prompt Token Estimation ─────────────────────────────────────

  describe('estimateSystemPromptTokens', () => {
    it('should estimate tokens based on agent count and tool count', () => {
      const template: TemplateInfo = {
        id: 'test',
        name: 'Test',
        roles: [
          { role: 'leader', count: 1, defaultTools: ['a', 'b', 'c'] },
          { role: 'worker', count: 2, defaultTools: ['a', 'b'] },
        ],
      };

      const tokens = service.estimateSystemPromptTokens(template);

      // Leader: (2000 + 3*50) * 1 = 2150
      // Worker: (2000 + 2*50) * 2 = 4200
      // Total: 6350
      expect(tokens).toBe(6350);
    });

    it('should handle roles with no tools', () => {
      const template: TemplateInfo = {
        id: 'test',
        name: 'Test',
        roles: [{ role: 'agent', count: 1 }],
      };

      const tokens = service.estimateSystemPromptTokens(template);
      expect(tokens).toBe(2000); // Base only, no tools
    });
  });

  // ── Confidence Determination ───────────────────────────────────────────

  describe('determineConfidence', () => {
    it('should return high with historical data and simple task', () => {
      expect(service.determineConfidence('simple', true, 1)).toBe('high');
    });

    it('should return medium with historical data and complex task', () => {
      expect(service.determineConfidence('complex', true, 5)).toBe('medium');
    });

    it('should return low without historical data and complex task with many agents', () => {
      expect(service.determineConfidence('very_complex', false, 10)).toBe('low');
    });

    it('should return medium for simple task without history', () => {
      expect(service.determineConfidence('simple', false, 2)).toBe('medium');
    });
  });

  // ── Token Estimation (Core) ────────────────────────────────────────────

  describe('estimateTokens', () => {
    beforeEach(() => {
      // Mock loadTemplate by mocking fs.readFile for directory-based template
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockDirectoryTemplate));
    });

    it('should return a complete estimate with all required fields', async () => {
      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a user registration form',
      });

      expect(estimate).toHaveProperty('estimatedInputTokens');
      expect(estimate).toHaveProperty('estimatedOutputTokens');
      expect(estimate).toHaveProperty('estimatedCost');
      expect(estimate).toHaveProperty('confidence');
      expect(estimate).toHaveProperty('breakdown');

      expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
      expect(estimate.estimatedOutputTokens).toBeGreaterThan(0);
      expect(estimate.estimatedCost).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(estimate.confidence);
    });

    it('should include breakdown details', async () => {
      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Add a button',
      });

      const { breakdown } = estimate;
      expect(breakdown.systemPromptTokens).toBeGreaterThan(0);
      expect(breakdown.toolOverheadTokens).toBeGreaterThan(0);
      expect(breakdown.conversationTokens).toBeGreaterThan(0);
      expect(breakdown.agentCount).toBe(3); // 1 TL + 2 devs
      expect(breakdown.estimatedTurns).toBeGreaterThan(0);
      expect(breakdown.taskComplexity).toBeDefined();
      expect(breakdown.modelMultiplier).toBeDefined();
      expect(breakdown.historicalCalibration).toBe(false);
    });

    it('should estimate more tokens for complex tasks', async () => {
      const simpleEstimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'fix typo',
      });
      const complexEstimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'refactor the entire microservice architecture with database schema migration and security audit',
      });

      const simpleTotal = simpleEstimate.estimatedInputTokens + simpleEstimate.estimatedOutputTokens;
      const complexTotal = complexEstimate.estimatedInputTokens + complexEstimate.estimatedOutputTokens;

      expect(complexTotal).toBeGreaterThan(simpleTotal);
    });

    it('should use provided modelId for cost calculation', async () => {
      const sonnetEstimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
        modelId: 'claude-sonnet-4-20250514',
      });
      const opusEstimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
        modelId: 'claude-opus-4-20250514',
      });

      // Opus has higher multiplier (1.4 vs 1.0), so more tokens
      const sonnetTotal = sonnetEstimate.estimatedInputTokens + sonnetEstimate.estimatedOutputTokens;
      const opusTotal = opusEstimate.estimatedInputTokens + opusEstimate.estimatedOutputTokens;
      expect(opusTotal).toBeGreaterThan(sonnetTotal);
    });

    it('should fall back to template model when modelId not provided', async () => {
      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      // Template's first role uses claude-sonnet-4-20250514 (multiplier 1.0)
      expect(estimate.breakdown.modelMultiplier).toBe(1.0);
    });

    it('should throw if template not found', async () => {
      mockedFs.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        service.estimateTokens({
          templateId: 'nonexistent',
          objective: 'test',
        }),
      ).rejects.toThrow('Template not found: nonexistent');
    });

    it('should calculate cost using model-specific rates', async () => {
      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Add a button',
        modelId: 'claude-sonnet-4-20250514',
      });

      // Sonnet: input=0.000003, output=0.000015
      // Cost = inputTokens * 0.000003 + outputTokens * 0.000015
      const expectedCost = Number(
        (estimate.estimatedInputTokens * 0.000003
         + estimate.estimatedOutputTokens * 0.000015).toFixed(4),
      );
      expect(estimate.estimatedCost).toBe(expectedCost);
    });
  });

  // ── Historical Calibration ─────────────────────────────────────────────

  describe('historical calibration', () => {
    beforeEach(() => {
      mockedFs.readFile.mockResolvedValue(JSON.stringify(mockDirectoryTemplate));
    });

    it('should calibrate estimate when historical data is available', async () => {
      const withoutHistory = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      // Set up historical data provider with higher-than-heuristic values
      service.setHistoricalDataProvider(() => [
        { totalInput: 50000, totalOutput: 30000, eventCount: 10 },
        { totalInput: 60000, totalOutput: 35000, eventCount: 12 },
        { totalInput: 55000, totalOutput: 32000, eventCount: 8 },
      ]);

      const withHistory = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      expect(withHistory.breakdown.historicalCalibration).toBe(true);
      // The estimate should be different when calibrated
      expect(withHistory.estimatedInputTokens).not.toBe(withoutHistory.estimatedInputTokens);
    });

    it('should not calibrate with fewer than MIN_HISTORICAL_EVENTS records', async () => {
      service.setHistoricalDataProvider(() => [
        { totalInput: 50000, totalOutput: 30000, eventCount: 10 },
        { totalInput: 60000, totalOutput: 35000, eventCount: 12 },
      ]);

      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      expect(estimate.breakdown.historicalCalibration).toBe(false);
    });

    it('should not calibrate when historical data has zero values', async () => {
      service.setHistoricalDataProvider(() => [
        { totalInput: 0, totalOutput: 0, eventCount: 0 },
        { totalInput: 0, totalOutput: 0, eventCount: 0 },
        { totalInput: 0, totalOutput: 0, eventCount: 0 },
      ]);

      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      expect(estimate.breakdown.historicalCalibration).toBe(false);
    });

    it('should handle provider errors gracefully', async () => {
      service.setHistoricalDataProvider(() => {
        throw new Error('Database connection failed');
      });

      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      expect(estimate.breakdown.historicalCalibration).toBe(false);
      expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    });

    it('should not calibrate when no provider is set', async () => {
      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'Build a feature',
      });

      expect(estimate.breakdown.historicalCalibration).toBe(false);
    });

    it('should increase confidence when historical data is used', async () => {
      // Without history: moderate task, 3 agents → likely medium or low
      service.setHistoricalDataProvider(() => [
        { totalInput: 50000, totalOutput: 30000, eventCount: 10 },
        { totalInput: 60000, totalOutput: 35000, eventCount: 12 },
        { totalInput: 55000, totalOutput: 32000, eventCount: 8 },
      ]);

      const estimate = await service.estimateTokens({
        templateId: 'dev-fullstack',
        objective: 'fix typo',
      });

      // Simple + historical + small agent count = high confidence
      expect(estimate.confidence).toBe('high');
    });
  });
});
