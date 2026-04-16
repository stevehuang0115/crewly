/**
 * Unit tests for Website Analysis Types
 *
 * Validates type structure, defaults, and type guard behavior.
 *
 * @module services/onboarding/website-analysis.types.test
 */

import type {
  AnalysisField,
  AnalysisDraft,
  AnalysisConfidence,
  AnalysisSource,
  AnalysisProgressEvent,
  AnalysisStage,
  AnalysisOptions,
  AnalysisResult,
  TemplateRecommendation,
} from './website-analysis.types.js';

describe('Website Analysis Types', () => {
  describe('AnalysisField', () => {
    it('should accept a valid AnalysisField object', () => {
      const field: AnalysisField = {
        value: 'Acme Corp',
        confidence: 'high',
        source: {
          url: 'https://acme.com',
          snippet: 'Welcome to Acme Corp',
          pageTitle: 'Acme Corp — Home',
          extractionMethod: 'meta-tags',
        },
      };

      expect(field.value).toBe('Acme Corp');
      expect(field.confidence).toBe('high');
      expect(field.source.url).toBe('https://acme.com');
      expect(field.source.extractionMethod).toBe('meta-tags');
    });

    it('should accept all confidence levels', () => {
      const levels: AnalysisConfidence[] = ['high', 'medium', 'low'];
      for (const level of levels) {
        const field: AnalysisField = {
          value: 'test',
          confidence: level,
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        };
        expect(field.confidence).toBe(level);
      }
    });

    it('should accept all extraction methods', () => {
      const methods: AnalysisSource['extractionMethod'][] = [
        'meta-tags', 'heading', 'paragraph', 'llm-inference', 'social-links',
      ];
      for (const method of methods) {
        const source: AnalysisSource = { url: '', snippet: '', extractionMethod: method };
        expect(source.extractionMethod).toBe(method);
      }
    });
  });

  describe('AnalysisDraft', () => {
    it('should have required missingFields and pagesAnalyzed', () => {
      const draft: AnalysisDraft = {
        missingFields: ['tone', 'targetCustomer'],
        pagesAnalyzed: [{ url: 'https://acme.com', title: 'Acme' }],
      };

      expect(draft.missingFields).toHaveLength(2);
      expect(draft.pagesAnalyzed).toHaveLength(1);
    });

    it('should allow all optional brand fields', () => {
      const field: AnalysisField = {
        value: 'test',
        confidence: 'medium',
        source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
      };

      const draft: AnalysisDraft = {
        businessName: field,
        industry: field,
        description: field,
        targetCustomer: field,
        brandPersonality: field,
        tone: field,
        goals: field,
        platforms: field,
        competitors: field,
        missingFields: [],
        pagesAnalyzed: [],
      };

      expect(draft.businessName).toBeDefined();
      expect(draft.competitors).toBeDefined();
    });

    it('should include template recommendation', () => {
      const rec: TemplateRecommendation = {
        templateId: 'pro-marketing-team',
        teamName: 'Acme AI Team',
        confidence: 'high',
        reason: 'Industry match',
      };

      const draft: AnalysisDraft = {
        recommendedTemplate: rec,
        missingFields: [],
        pagesAnalyzed: [],
      };

      expect(draft.recommendedTemplate?.templateId).toBe('pro-marketing-team');
    });
  });

  describe('AnalysisProgressEvent', () => {
    it('should accept all 4 stages', () => {
      const stages: AnalysisStage[] = [
        'fetching_homepage',
        'discovering_pages',
        'extracting_content',
        'generating_draft',
      ];

      for (const stage of stages) {
        const event: AnalysisProgressEvent = {
          stage,
          message: `In ${stage}`,
          progress: 50,
        };
        expect(event.stage).toBe(stage);
      }
    });

    it('should support error field', () => {
      const event: AnalysisProgressEvent = {
        stage: 'fetching_homepage',
        message: 'DNS failure',
        progress: 10,
        error: 'ENOTFOUND',
      };
      expect(event.error).toBe('ENOTFOUND');
    });
  });

  describe('AnalysisResult', () => {
    it('should represent a successful analysis', () => {
      const result: AnalysisResult = {
        success: true,
        draft: { missingFields: [], pagesAnalyzed: [] },
        durationMs: 5000,
        pagesFetched: 3,
      };

      expect(result.success).toBe(true);
      expect(result.durationMs).toBe(5000);
    });

    it('should represent a failed analysis', () => {
      const result: AnalysisResult = {
        success: false,
        draft: { missingFields: ['businessName'], pagesAnalyzed: [] },
        durationMs: 2000,
        pagesFetched: 0,
        error: 'Network timeout',
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });
  });

  describe('AnalysisOptions', () => {
    it('should accept minimal options', () => {
      const opts: AnalysisOptions = { url: 'https://example.com' };
      expect(opts.url).toBe('https://example.com');
      expect(opts.maxPages).toBeUndefined();
      expect(opts.timeoutMs).toBeUndefined();
    });

    it('should accept full options', () => {
      const opts: AnalysisOptions = {
        url: 'https://example.com',
        maxPages: 10,
        timeoutMs: 60000,
        onProgress: () => {},
      };
      expect(opts.maxPages).toBe(10);
      expect(opts.timeoutMs).toBe(60000);
    });
  });
});
