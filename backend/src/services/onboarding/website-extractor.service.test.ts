/**
 * Tests for WebsiteExtractorService — AI-powered website extraction pipeline.
 *
 * Mocks fetch() and LLM calls to test the full extraction pipeline
 * including HTML parsing, metadata extraction, confidence scoring,
 * and partial extraction on failure.
 *
 * @module services/onboarding/website-extractor.service.test
 */

// Mock logger
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

import { WebsiteExtractorService } from './website-extractor.service.js';
import type {
  ProcessedPage,
  LlmExtractionResult,
  PageMetadata,
} from './website-extractor.service.js';

// ---------------------------------------------------------------------------
// Test HTML fixtures
// ---------------------------------------------------------------------------

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Sunrise Bakery — Artisan Sourdough</title>
  <meta name="description" content="We make artisan sourdough bread for health-conscious families in Portland.">
  <meta property="og:title" content="Sunrise Bakery">
  <meta property="og:description" content="Handcrafted sourdough and pastries since 2019.">
  <meta property="og:image" content="https://sunrisebakery.com/hero.jpg">
  <meta property="og:site_name" content="Sunrise Bakery">
  <link rel="canonical" href="https://sunrisebakery.com/">
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About Us</a>
    <a href="/products">Our Breads</a>
    <a href="/team">Meet the Team</a>
  </nav>
  <main>
    <h1>Welcome to Sunrise Bakery</h1>
    <p>We are Portland's favorite artisan bakery, crafting sourdough bread with organic ingredients since 2019.</p>
    <p>Our mission is to bring healthy, delicious bread to every family's table.</p>
    <h2>What We Offer</h2>
    <ul>
      <li>Classic Sourdough Loaf</li>
      <li>Whole Wheat Sourdough</li>
      <li>Organic Pastries</li>
    </ul>
    <p>Follow us on social media:</p>
    <a href="https://instagram.com/sunrisebakery">Instagram</a>
    <a href="https://www.facebook.com/sunrisebakery">Facebook</a>
    <a href="https://twitter.com/sunrisebakery">Twitter</a>
    <a href="https://www.linkedin.com/company/sunrisebakery">LinkedIn</a>
  </main>
  <script>console.log('analytics');</script>
  <style>.hidden { display: none; }</style>
</body>
</html>`;

const MINIMAL_HTML = `
<html>
<head><title>Test Page</title></head>
<body><p>Hello world</p></body>
</html>`;

const NO_META_HTML = `
<html>
<body>
<h1>My Business</h1>
<p>We sell things online.</p>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Helper: create mock fetch
// ---------------------------------------------------------------------------

function createMockFetch(responses: Record<string, { status: number; html: string; contentType?: string }>): typeof globalThis.fetch {
  return jest.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const response = responses[url];

    if (!response) {
      return new Response('Not Found', { status: 404 });
    }

    return new Response(response.html, {
      status: response.status,
      headers: { 'content-type': response.contentType || 'text/html; charset=utf-8' },
    });
  }) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebsiteExtractorService', () => {
  let service: WebsiteExtractorService;

  beforeEach(() => {
    WebsiteExtractorService.resetInstance();
    service = WebsiteExtractorService.getInstance();
  });

  afterEach(() => {
    WebsiteExtractorService.resetInstance();
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    it('should return the same instance', () => {
      expect(WebsiteExtractorService.getInstance()).toBe(service);
    });

    it('should return new instance after reset', () => {
      WebsiteExtractorService.resetInstance();
      expect(WebsiteExtractorService.getInstance()).not.toBe(service);
    });
  });

  // -------------------------------------------------------------------------
  // extractMetadata
  // -------------------------------------------------------------------------

  describe('extractMetadata', () => {
    it('should extract all metadata fields from well-formed HTML', () => {
      const meta = service.extractMetadata(SAMPLE_HTML);
      expect(meta.title).toBe('Sunrise Bakery — Artisan Sourdough');
      expect(meta.description).toBe('We make artisan sourdough bread for health-conscious families in Portland.');
      expect(meta.ogTitle).toBe('Sunrise Bakery');
      expect(meta.ogDescription).toBe('Handcrafted sourdough and pastries since 2019.');
      expect(meta.ogImage).toBe('https://sunrisebakery.com/hero.jpg');
      expect(meta.ogSiteName).toBe('Sunrise Bakery');
      expect(meta.canonical).toBe('https://sunrisebakery.com/');
    });

    it('should return empty strings for missing metadata', () => {
      const meta = service.extractMetadata(NO_META_HTML);
      expect(meta.title).toBe('');
      expect(meta.description).toBe('');
      expect(meta.ogTitle).toBe('');
    });

    it('should handle minimal HTML', () => {
      const meta = service.extractMetadata(MINIMAL_HTML);
      expect(meta.title).toBe('Test Page');
      expect(meta.description).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // extractVisibleText
  // -------------------------------------------------------------------------

  describe('extractVisibleText', () => {
    it('should strip HTML tags and return visible text', () => {
      const text = service.extractVisibleText(SAMPLE_HTML);
      expect(text).toContain('Welcome to Sunrise Bakery');
      expect(text).toContain('artisan bakery');
      expect(text).toContain('Classic Sourdough Loaf');
    });

    it('should remove script and style tags and their content', () => {
      const text = service.extractVisibleText(SAMPLE_HTML);
      expect(text).not.toContain('console.log');
      expect(text).not.toContain('analytics');
      expect(text).not.toContain('.hidden');
    });

    it('should remove nav content', () => {
      const text = service.extractVisibleText(SAMPLE_HTML);
      // Nav links should be stripped
      expect(text).not.toContain('Home');
    });

    it('should decode HTML entities', () => {
      const html = '<p>Tom &amp; Jerry &lt;3 each other&nbsp;forever</p>';
      const text = service.extractVisibleText(html);
      expect(text).toContain('Tom & Jerry');
      expect(text).toContain('<3');
    });

    it('should truncate to 10,000 chars', () => {
      const longHtml = '<p>' + 'a'.repeat(20000) + '</p>';
      const text = service.extractVisibleText(longHtml);
      expect(text.length).toBeLessThanOrEqual(10000);
    });
  });

  // -------------------------------------------------------------------------
  // extractLinks
  // -------------------------------------------------------------------------

  describe('extractLinks', () => {
    it('should extract all links from HTML', () => {
      const links = service.extractLinks(SAMPLE_HTML, 'https://sunrisebakery.com');
      expect(links).toContain('https://instagram.com/sunrisebakery');
      expect(links).toContain('https://www.facebook.com/sunrisebakery');
      expect(links).toContain('https://twitter.com/sunrisebakery');
    });

    it('should resolve relative URLs against base', () => {
      const links = service.extractLinks(SAMPLE_HTML, 'https://sunrisebakery.com');
      expect(links).toContain('https://sunrisebakery.com/about');
      expect(links).toContain('https://sunrisebakery.com/products');
    });

    it('should deduplicate links', () => {
      const html = '<a href="/page">1</a><a href="/page">2</a>';
      const links = service.extractLinks(html, 'https://example.com');
      const pageLinks = links.filter((l) => l === 'https://example.com/page');
      expect(pageLinks).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // findImportantLinks
  // -------------------------------------------------------------------------

  describe('findImportantLinks', () => {
    it('should prioritize about/team pages and social links', () => {
      const page: ProcessedPage = {
        url: 'https://sunrisebakery.com',
        metadata: {} as PageMetadata,
        textContent: '',
        links: [
          'https://sunrisebakery.com/about',
          'https://sunrisebakery.com/contact',
          'https://sunrisebakery.com/products',
          'https://sunrisebakery.com/team',
          'https://instagram.com/sunrisebakery',
          'https://twitter.com/sunrisebakery',
          'https://facebook.com/sunrisebakery',
          'https://linkedin.com/company/sunrisebakery',
        ],
      };

      const important = service.findImportantLinks(page, 'https://sunrisebakery.com');
      // Should include about + team (same-domain) and social links
      expect(important.some((l) => l.includes('/about'))).toBe(true);
      expect(important.some((l) => l.includes('instagram'))).toBe(true);
      // Max 5 total (2 about + 3 social)
      expect(important.length).toBeLessThanOrEqual(5);
    });

    it('should return empty for pages with no important links', () => {
      const page: ProcessedPage = {
        url: 'https://example.com',
        metadata: {} as PageMetadata,
        textContent: '',
        links: ['https://example.com/random-page'],
      };

      const important = service.findImportantLinks(page, 'https://example.com');
      expect(important).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // normalizeUrl
  // -------------------------------------------------------------------------

  describe('normalizeUrl', () => {
    it('should add https:// if no protocol', () => {
      expect(service.normalizeUrl('example.com')).toBe('https://example.com');
    });

    it('should keep existing https://', () => {
      expect(service.normalizeUrl('https://example.com')).toBe('https://example.com');
    });

    it('should keep existing http://', () => {
      expect(service.normalizeUrl('http://example.com')).toBe('http://example.com');
    });

    it('should trim whitespace', () => {
      expect(service.normalizeUrl('  example.com  ')).toBe('https://example.com');
    });
  });

  // -------------------------------------------------------------------------
  // detectPlatformsFromLinks
  // -------------------------------------------------------------------------

  describe('detectPlatformsFromLinks', () => {
    it('should detect platform names from social URLs', () => {
      const platforms = service.detectPlatformsFromLinks([
        'https://twitter.com/brand',
        'https://instagram.com/brand',
        'https://www.linkedin.com/company/brand',
        'https://www.facebook.com/brand',
        'https://youtube.com/brand',
        'https://tiktok.com/@brand',
      ]);

      expect(platforms).toContain('X (Twitter)');
      expect(platforms).toContain('Instagram');
      expect(platforms).toContain('LinkedIn');
      expect(platforms).toContain('Facebook');
      expect(platforms).toContain('YouTube');
      expect(platforms).toContain('TikTok');
    });

    it('should handle x.com as Twitter', () => {
      const platforms = service.detectPlatformsFromLinks(['https://x.com/brand']);
      expect(platforms).toContain('X (Twitter)');
    });

    it('should deduplicate platforms', () => {
      const platforms = service.detectPlatformsFromLinks([
        'https://twitter.com/brand',
        'https://x.com/brand',
      ]);
      const twitterCount = platforms.filter((p) => p === 'X (Twitter)').length;
      expect(twitterCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // createPrefillField
  // -------------------------------------------------------------------------

  describe('createPrefillField', () => {
    it('should create a high confidence field that does not need review', () => {
      const field = service.createPrefillField('Test', ['https://example.com'], 'high');
      expect(field.value).toBe('Test');
      expect(field.confidence).toBe('high');
      expect(field.needsReview).toBe(false);
      expect(field.extractionMethod).toBe('llm_text');
    });

    it('should create a medium confidence field that needs review', () => {
      const field = service.createPrefillField('Inferred', ['https://example.com'], 'medium');
      expect(field.needsReview).toBe(true);
    });

    it('should create a low confidence field that needs review', () => {
      const field = service.createPrefillField('Guessed', ['https://example.com'], 'low');
      expect(field.needsReview).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // mapToPrefill
  // -------------------------------------------------------------------------

  describe('mapToPrefill', () => {
    const pages: ProcessedPage[] = [{
      url: 'https://example.com',
      metadata: {} as PageMetadata,
      textContent: '',
      links: [],
    }];

    it('should map all LLM fields to PrefillFields', () => {
      const result: LlmExtractionResult = {
        businessName: 'Sunrise Bakery',
        industry: 'Food & Beverage',
        description: 'Artisan bakery in Portland',
        targetCustomer: 'Health-conscious millennials',
        competitors: ['Blue Apron', 'HelloFresh'],
        personality: ['Professional', 'Friendly', 'Warm'],
        tone: 'casual',
        platforms: ['Instagram', 'Facebook'],
        goals: ['Brand awareness', 'Community building'],
        contentExamples: ['https://instagram.com/p/123'],
        fieldConfidence: {
          businessName: 'high',
          industry: 'high',
          description: 'medium',
          targetCustomer: 'low',
          competitors: 'low',
          personality: 'medium',
          tone: 'medium',
          platforms: 'high',
          goals: 'low',
          contentExamples: 'medium',
        },
      };

      const prefill = service.mapToPrefill(result, pages);

      expect(prefill.businessName?.value).toBe('Sunrise Bakery');
      expect(prefill.businessName?.confidence).toBe('high');
      expect(prefill.businessName?.needsReview).toBe(false);

      expect(prefill.industry?.value).toBe('Food & Beverage');
      expect(prefill.targetCustomer?.confidence).toBe('low');
      expect(prefill.platforms?.value).toEqual(['Instagram', 'Facebook']);
      expect(prefill.competitors?.value).toEqual(['Blue Apron', 'HelloFresh']);
    });

    it('should omit fields not present in LLM result', () => {
      const result: LlmExtractionResult = {
        businessName: 'Test Co',
      };

      const prefill = service.mapToPrefill(result, pages);
      expect(prefill.businessName).toBeDefined();
      expect(prefill.industry).toBeUndefined();
      expect(prefill.competitors).toBeUndefined();
    });

    it('should omit empty arrays', () => {
      const result: LlmExtractionResult = {
        competitors: [],
        personality: [],
      };

      const prefill = service.mapToPrefill(result, pages);
      expect(prefill.competitors).toBeUndefined();
      expect(prefill.personality).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // buildMetadataOnlyPrefill
  // -------------------------------------------------------------------------

  describe('buildMetadataOnlyPrefill', () => {
    it('should extract business name and description from metadata', () => {
      const pages: ProcessedPage[] = [{
        url: 'https://sunrisebakery.com',
        metadata: {
          title: 'Sunrise Bakery',
          description: 'Artisan sourdough in Portland',
          ogTitle: '',
          ogDescription: 'Best sourdough in town',
          ogImage: '',
          ogSiteName: 'Sunrise Bakery',
          canonical: '',
        },
        textContent: '',
        links: ['https://instagram.com/sunrisebakery'],
      }];

      const prefill = service.buildMetadataOnlyPrefill(pages);
      expect(prefill.businessName?.value).toBe('Sunrise Bakery');
      expect(prefill.description?.value).toBe('Best sourdough in town');
      expect(prefill.platforms?.value).toContain('Instagram');
    });

    it('should return empty prefill for empty pages', () => {
      const prefill = service.buildMetadataOnlyPrefill([]);
      expect(Object.keys(prefill)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // parseLlmResponse
  // -------------------------------------------------------------------------

  describe('parseLlmResponse', () => {
    it('should parse valid JSON response', () => {
      const json = JSON.stringify({ businessName: 'Test', industry: 'Tech' });
      const result = service.parseLlmResponse(json);
      expect(result.businessName).toBe('Test');
      expect(result.industry).toBe('Tech');
    });

    it('should handle JSON wrapped in markdown code fences', () => {
      const text = '```json\n{"businessName": "Fenced"}\n```';
      const result = service.parseLlmResponse(text);
      expect(result.businessName).toBe('Fenced');
    });

    it('should return empty object for invalid JSON', () => {
      const result = service.parseLlmResponse('not json at all');
      expect(result).toEqual({});
    });

    it('should handle empty string', () => {
      const result = service.parseLlmResponse('');
      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // extract (full pipeline)
  // -------------------------------------------------------------------------

  describe('extract (full pipeline)', () => {
    it('should fetch homepage, call LLM, and return prefill', async () => {
      service.setFetchFn(createMockFetch({
        'https://sunrisebakery.com': { status: 200, html: SAMPLE_HTML },
      }));

      const mockLlmResult: LlmExtractionResult = {
        businessName: 'Sunrise Bakery',
        industry: 'Food & Beverage',
        description: 'Portland artisan bakery',
        platforms: ['Instagram', 'Facebook', 'Twitter'],
        fieldConfidence: {
          businessName: 'high',
          industry: 'high',
          description: 'medium',
          platforms: 'high',
        },
      };

      service.setLlmExtractFn(jest.fn().mockResolvedValue(mockLlmResult));

      const prefill = await service.extract('https://sunrisebakery.com');

      expect(prefill.businessName?.value).toBe('Sunrise Bakery');
      expect(prefill.businessName?.confidence).toBe('high');
      expect(prefill.industry?.value).toBe('Food & Beverage');
      expect(prefill.platforms?.value).toEqual(['Instagram', 'Facebook', 'Twitter']);
    });

    it('should normalize URL without protocol', async () => {
      const mockFetch = createMockFetch({
        'https://example.com': { status: 200, html: MINIMAL_HTML },
      });
      service.setFetchFn(mockFetch);
      service.setLlmExtractFn(jest.fn().mockResolvedValue({ businessName: 'Example' }));

      await service.extract('example.com');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    });

    it('should return empty prefill when fetch fails', async () => {
      service.setFetchFn(jest.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch);

      const prefill = await service.extract('https://broken.com');
      expect(Object.keys(prefill)).toHaveLength(0);
    });

    it('should return metadata-only prefill when LLM fails', async () => {
      service.setFetchFn(createMockFetch({
        'https://sunrisebakery.com': { status: 200, html: SAMPLE_HTML },
      }));

      service.setLlmExtractFn(jest.fn().mockRejectedValue(new Error('LLM timeout')));

      const prefill = await service.extract('https://sunrisebakery.com');
      // Should have at least businessName from metadata
      expect(prefill.businessName?.value).toBe('Sunrise Bakery');
      expect(prefill.businessName?.confidence).toBe('medium');
    });

    it('should follow about page links', async () => {
      const aboutHtml = `
        <html><head><title>About Us</title></head>
        <body><p>Founded in 2019 by master baker John.</p></body>
        </html>`;

      const mockFetch = createMockFetch({
        'https://sunrisebakery.com': { status: 200, html: SAMPLE_HTML },
        'https://sunrisebakery.com/about': { status: 200, html: aboutHtml },
      });
      service.setFetchFn(mockFetch);

      const llmFn = jest.fn().mockResolvedValue({ businessName: 'Sunrise Bakery' });
      service.setLlmExtractFn(llmFn);

      await service.extract('https://sunrisebakery.com');

      // LLM should receive both pages
      expect(llmFn).toHaveBeenCalledTimes(1);
      const pages = llmFn.mock.calls[0][1] as ProcessedPage[];
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(pages[1].url).toBe('https://sunrisebakery.com/about');
    });

    it('should handle non-HTML content type gracefully', async () => {
      service.setFetchFn(createMockFetch({
        'https://example.com': { status: 200, html: '{}', contentType: 'application/json' },
      }));

      const prefill = await service.extract('https://example.com');
      expect(Object.keys(prefill)).toHaveLength(0);
    });

    it('should handle 404 response gracefully', async () => {
      service.setFetchFn(createMockFetch({
        'https://example.com': { status: 404, html: 'Not Found' },
      }));

      const prefill = await service.extract('https://example.com');
      expect(Object.keys(prefill)).toHaveLength(0);
    });
  });
});
