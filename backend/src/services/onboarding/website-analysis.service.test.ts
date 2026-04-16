/**
 * Unit tests for WebsiteAnalysisService
 *
 * Tests the 4-stage analysis pipeline: fetch, discover, extract, draft.
 * Mocks WebsiteExtractorService to avoid real network/LLM calls.
 *
 * @module services/onboarding/website-analysis.service.test
 */

import type { ProcessedPage, LlmExtractionResult } from './website-extractor.service.js';
import type {
  AnalysisDraft,
  AnalysisProgressEvent,
  AnalysisResult,
} from './website-analysis.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchAndProcess = jest.fn<Promise<ProcessedPage | null>, [string]>();
const mockFindImportantLinks = jest.fn<string[], [ProcessedPage, string]>();
const mockCallLlmExtraction = jest.fn<Promise<LlmExtractionResult>, [ProcessedPage[]]>();

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

jest.mock('./website-extractor.service.js', () => ({
  WebsiteExtractorService: {
    getInstance: () => ({
      fetchAndProcess: mockFetchAndProcess,
      findImportantLinks: mockFindImportantLinks,
      callLlmExtraction: mockCallLlmExtraction,
    }),
  },
}));

// Import after mocks
import { WebsiteAnalysisService } from './website-analysis.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock ProcessedPage for testing */
function createMockPage(overrides: Partial<ProcessedPage> = {}): ProcessedPage {
  return {
    url: 'https://example.com',
    metadata: {
      title: 'Example Business — Professional Services',
      description: 'We provide professional business consulting services.',
      ogTitle: 'Example Business',
      ogDescription: 'Professional business consulting',
      ogImage: '',
      ogSiteName: 'Example Business',
      canonical: 'https://example.com',
    },
    textContent: 'Example Business. We provide professional business consulting services to small businesses.',
    links: ['https://example.com/about', 'https://example.com/services'],
    ...overrides,
  };
}

/** Create a mock LLM extraction result */
function createMockLlmResult(overrides: Partial<LlmExtractionResult> = {}): LlmExtractionResult {
  return {
    businessName: 'Example Business',
    industry: 'Business Consulting',
    description: 'Professional business consulting for SMBs',
    targetCustomer: 'Small business owners aged 30-55',
    personality: ['Professional', 'Trustworthy', 'Knowledgeable'],
    tone: 'authoritative',
    goals: ['Brand awareness', 'Lead generation'],
    platforms: ['LinkedIn', 'Twitter'],
    competitors: ['Competitor A', 'Competitor B'],
    fieldConfidence: {
      businessName: 'high',
      industry: 'high',
      description: 'high',
      targetCustomer: 'medium',
      personality: 'medium',
      tone: 'medium',
      goals: 'low',
      platforms: 'high',
      competitors: 'low',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebsiteAnalysisService', () => {
  let service: WebsiteAnalysisService;

  beforeEach(() => {
    WebsiteAnalysisService.resetInstance();
    service = WebsiteAnalysisService.getInstance();
    jest.clearAllMocks();

    // Default mock behavior
    mockFindImportantLinks.mockReturnValue([]);
    mockCallLlmExtraction.mockResolvedValue(createMockLlmResult());
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = WebsiteAnalysisService.getInstance();
      const b = WebsiteAnalysisService.getInstance();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = WebsiteAnalysisService.getInstance();
      WebsiteAnalysisService.resetInstance();
      const b = WebsiteAnalysisService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // -------------------------------------------------------------------------
  // Full Pipeline
  // -------------------------------------------------------------------------

  describe('analyze — full pipeline', () => {
    it('should produce a complete AnalysisDraft for a successful analysis', async () => {
      const homepage = createMockPage();
      mockFetchAndProcess.mockResolvedValue(homepage);
      mockFindImportantLinks.mockReturnValue(['https://example.com/about']);

      const aboutPage = createMockPage({
        url: 'https://example.com/about',
        metadata: { ...createMockPage().metadata, title: 'About Us' },
        textContent: 'About our consulting firm...',
      });
      mockFetchAndProcess
        .mockResolvedValueOnce(homepage)
        .mockResolvedValueOnce(aboutPage);

      const result = await service.analyze({ url: 'https://example.com' });

      expect(result.success).toBe(true);
      expect(result.draft.businessName).toBeDefined();
      expect(result.draft.businessName!.value).toBe('Example Business');
      expect(result.draft.businessName!.confidence).toBe('high');
      expect(result.draft.businessName!.source).toBeDefined();
      expect(result.draft.pagesAnalyzed.length).toBeGreaterThanOrEqual(1);
      expect(result.pagesFetched).toBeGreaterThanOrEqual(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include all extracted fields with confidence', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage());

      const result = await service.analyze({ url: 'example.com' });

      expect(result.success).toBe(true);
      const { draft } = result;

      // All fields from LLM should be present
      expect(draft.businessName?.value).toBe('Example Business');
      expect(draft.industry?.value).toBe('Business Consulting');
      expect(draft.description?.value).toBe('Professional business consulting for SMBs');
      expect(draft.targetCustomer?.value).toBe('Small business owners aged 30-55');
      expect(draft.tone?.value).toBe('authoritative');
      expect(draft.brandPersonality?.value).toContain('Professional');
    });

    it('should normalize URL without protocol', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage());

      await service.analyze({ url: 'example.com' });

      expect(mockFetchAndProcess).toHaveBeenCalledWith('https://example.com');
    });
  });

  // -------------------------------------------------------------------------
  // Progress Events
  // -------------------------------------------------------------------------

  describe('analyze — progress events', () => {
    it('should emit progress events for all 4 stages', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage());

      const events: AnalysisProgressEvent[] = [];
      await service.analyze({
        url: 'https://example.com',
        onProgress: (e) => events.push(e),
      });

      const stages = events.map((e) => e.stage);
      expect(stages).toContain('fetching_homepage');
      expect(stages).toContain('discovering_pages');
      expect(stages).toContain('extracting_content');
      expect(stages).toContain('generating_draft');
    });

    it('should emit progress from 10 to 100', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage());

      const events: AnalysisProgressEvent[] = [];
      await service.analyze({
        url: 'https://example.com',
        onProgress: (e) => events.push(e),
      });

      expect(events[0].progress).toBe(10);
      expect(events[events.length - 1].progress).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // Error Handling
  // -------------------------------------------------------------------------

  describe('analyze — error handling', () => {
    it('should return failure when homepage fetch fails', async () => {
      mockFetchAndProcess.mockRejectedValue(new Error('DNS resolution failed'));

      const result = await service.analyze({ url: 'https://nonexistent.invalid' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch homepage');
      expect(result.draft.missingFields).toEqual([]);
      expect(result.pagesFetched).toBe(0);
    });

    it('should return failure when homepage returns null', async () => {
      mockFetchAndProcess.mockResolvedValue(null);

      const result = await service.analyze({ url: 'https://empty.example.com' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('no content');
    });

    it('should use metadata-only draft when LLM fails', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage());
      mockCallLlmExtraction.mockRejectedValue(new Error('LLM timeout'));

      const result = await service.analyze({ url: 'https://example.com' });

      // Should still succeed with partial results
      expect(result.success).toBe(true);
      // Metadata fields should still be populated
      expect(result.draft.businessName).toBeDefined();
      expect(result.draft.businessName!.value).toBe('Example Business');
      // But LLM-only fields should be missing
      expect(result.draft.missingFields.length).toBeGreaterThan(0);
    });

    it('should skip failed additional pages gracefully', async () => {
      const homepage = createMockPage();
      mockFetchAndProcess
        .mockResolvedValueOnce(homepage)
        .mockRejectedValueOnce(new Error('404'));
      mockFindImportantLinks.mockReturnValue(['https://example.com/broken-page']);

      const result = await service.analyze({ url: 'https://example.com' });

      expect(result.success).toBe(true);
      expect(result.draft.pagesAnalyzed.length).toBe(1); // Only homepage
    });
  });

  // -------------------------------------------------------------------------
  // Template Recommendation
  // -------------------------------------------------------------------------

  describe('recommendTemplate', () => {
    it('should recommend marketing template for marketing industry', () => {
      const draft: AnalysisDraft = {
        industry: {
          value: 'Digital Marketing',
          confidence: 'high',
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        },
        businessName: {
          value: 'Acme Marketing',
          confidence: 'high',
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        },
        missingFields: [],
        pagesAnalyzed: [],
      };

      const rec = service.recommendTemplate(draft);
      expect(rec.templateId).toBe('pro-marketing-team');
      expect(rec.confidence).toBe('high');
      expect(rec.teamName).toContain('Acme Marketing');
    });

    it('should recommend dev template for technology industry', () => {
      const draft: AnalysisDraft = {
        industry: {
          value: 'SaaS Technology',
          confidence: 'high',
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        },
        businessName: {
          value: 'TechCo',
          confidence: 'high',
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        },
        missingFields: [],
        pagesAnalyzed: [],
      };

      const rec = service.recommendTemplate(draft);
      expect(rec.templateId).toBe('pro-dev-fullstack');
    });

    it('should return default template with low confidence for unknown industry', () => {
      const draft: AnalysisDraft = {
        industry: {
          value: 'Underwater Basket Weaving',
          confidence: 'high',
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        },
        missingFields: [],
        pagesAnalyzed: [],
      };

      const rec = service.recommendTemplate(draft);
      expect(rec.templateId).toBe('pro-marketing-team');
      expect(rec.confidence).toBe('low');
    });

    it('should detect social media from description when industry is unknown', () => {
      const draft: AnalysisDraft = {
        description: {
          value: 'We help businesses grow through social media marketing',
          confidence: 'high',
          source: { url: '', snippet: '', extractionMethod: 'llm-inference' },
        },
        missingFields: [],
        pagesAnalyzed: [],
      };

      const rec = service.recommendTemplate(draft);
      expect(rec.templateId).toBe('pro-social-media-ops');
      expect(rec.confidence).toBe('medium');
    });
  });

  // -------------------------------------------------------------------------
  // Missing Fields
  // -------------------------------------------------------------------------

  describe('missing fields identification', () => {
    it('should identify all missing fields when LLM returns empty result', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage({
        metadata: {
          title: '',
          description: '',
          ogTitle: '',
          ogDescription: '',
          ogImage: '',
          ogSiteName: '',
          canonical: '',
        },
      }));
      mockCallLlmExtraction.mockResolvedValue({});

      const result = await service.analyze({ url: 'https://example.com' });

      expect(result.draft.missingFields.length).toBeGreaterThan(0);
      expect(result.draft.missingFields).toContain('targetCustomer');
      expect(result.draft.missingFields).toContain('tone');
    });

    it('should have no missing fields when all fields are extracted', async () => {
      mockFetchAndProcess.mockResolvedValue(createMockPage());
      mockCallLlmExtraction.mockResolvedValue(createMockLlmResult());

      const result = await service.analyze({ url: 'https://example.com' });

      expect(result.draft.missingFields).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Pages Analyzed
  // -------------------------------------------------------------------------

  describe('pages analyzed tracking', () => {
    it('should track all analyzed pages', async () => {
      const homepage = createMockPage();
      const aboutPage = createMockPage({
        url: 'https://example.com/about',
        metadata: { ...createMockPage().metadata, title: 'About Us' },
      });

      mockFetchAndProcess
        .mockResolvedValueOnce(homepage)
        .mockResolvedValueOnce(aboutPage);
      mockFindImportantLinks.mockReturnValue(['https://example.com/about']);

      const result = await service.analyze({ url: 'https://example.com' });

      expect(result.draft.pagesAnalyzed).toHaveLength(2);
      expect(result.draft.pagesAnalyzed[0].url).toBe('https://example.com');
      expect(result.draft.pagesAnalyzed[1].url).toBe('https://example.com/about');
    });
  });
});
