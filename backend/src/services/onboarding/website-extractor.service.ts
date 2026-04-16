/**
 * Website Extractor Service — AI-Powered Auto-Onboarding Pipeline
 *
 * Scrapes a customer's website URL and produces structured PrefillField data
 * for the onboarding flow. Pipeline: fetch HTML → extract metadata → strip to
 * visible text → call Claude via AI SDK generateObject → map to OnboardingPrefill.
 *
 * Architecture:
 * - Uses native fetch for HTTP requests (no Playwright for MVP)
 * - Uses @ai-sdk/anthropic + generateObject for structured LLM extraction
 * - Max 5 pages per domain, 15s fetch timeout, 30s LLM timeout
 * - Partial results returned on failure (graceful degradation)
 *
 * @module services/onboarding/website-extractor.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type {
  OnboardingPrefill,
  PrefillField,
  PrefillConfidence,
} from './brand-onboarding.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of pages to fetch per extraction */
const MAX_PAGES_PER_DOMAIN = 5;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15_000;

/** LLM call timeout in milliseconds */
const LLM_TIMEOUT_MS = 30_000;

/** Maximum HTML content length to process (500KB) */
const MAX_CONTENT_LENGTH = 500_000;

/** Claude model to use for extraction */
const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

/** User-Agent header for fetch requests */
const USER_AGENT = 'CrewlyBot/1.0 (+https://crewlyai.com)';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata extracted from HTML head and meta tags */
export interface PageMetadata {
  /** Page title from <title> tag */
  title: string;
  /** Meta description */
  description: string;
  /** Open Graph title */
  ogTitle: string;
  /** Open Graph description */
  ogDescription: string;
  /** Open Graph image URL */
  ogImage: string;
  /** Open Graph site name */
  ogSiteName: string;
  /** Canonical URL */
  canonical: string;
}

/** Processed page content ready for LLM extraction */
export interface ProcessedPage {
  /** Source URL */
  url: string;
  /** Extracted metadata */
  metadata: PageMetadata;
  /** Visible text content (HTML stripped) */
  textContent: string;
  /** Social/about links found on the page */
  links: string[];
}

/** Raw LLM extraction result before mapping to PrefillFields */
export interface LlmExtractionResult {
  businessName?: string;
  industry?: string;
  description?: string;
  targetCustomer?: string;
  competitors?: string[];
  personality?: string[];
  tone?: string;
  platforms?: string[];
  goals?: string[];
  contentExamples?: string[];
  /** Per-field confidence as assessed by the LLM */
  fieldConfidence?: Record<string, 'high' | 'medium' | 'low'>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Website Extractor Service — singleton that scrapes a website URL and
 * produces structured OnboardingPrefill data for brand onboarding.
 *
 * @example
 * ```typescript
 * const extractor = WebsiteExtractorService.getInstance();
 * const prefill = await extractor.extract('https://example.com');
 * ```
 */
export class WebsiteExtractorService {
  private static instance: WebsiteExtractorService | null = null;
  private readonly logger: ComponentLogger;

  /** Injected fetch function — allows test mocking */
  private fetchFn: typeof globalThis.fetch;

  /** Injected LLM call function — allows test mocking */
  private llmExtractFn: ((prompt: string, pageData: ProcessedPage[]) => Promise<LlmExtractionResult>) | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('WebsiteExtractorService');
    this.fetchFn = globalThis.fetch;
  }

  /**
   * Get the singleton instance.
   *
   * @returns WebsiteExtractorService instance
   */
  static getInstance(): WebsiteExtractorService {
    if (!WebsiteExtractorService.instance) {
      WebsiteExtractorService.instance = new WebsiteExtractorService();
    }
    return WebsiteExtractorService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    WebsiteExtractorService.instance = null;
  }

  /**
   * Override the fetch function (for testing).
   *
   * @param fn - Custom fetch implementation
   */
  setFetchFn(fn: typeof globalThis.fetch): void {
    this.fetchFn = fn;
  }

  /**
   * Override the LLM extraction function (for testing).
   *
   * @param fn - Custom LLM extraction implementation
   */
  setLlmExtractFn(fn: (prompt: string, pageData: ProcessedPage[]) => Promise<LlmExtractionResult>): void {
    this.llmExtractFn = fn;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Extract brand profile data from a website URL.
   *
   * Pipeline steps:
   * 1. Fetch homepage HTML
   * 2. Extract metadata (title, og tags, meta description)
   * 3. Extract visible text content (strip HTML)
   * 4. Find about/social links
   * 5. Optionally fetch about page for richer context
   * 6. Call LLM with structured extraction prompt
   * 7. Map to OnboardingPrefill with confidence + sourceUrls
   *
   * @param url - Website URL to scrape
   * @returns OnboardingPrefill with extracted fields
   */
  async extract(url: string): Promise<OnboardingPrefill> {
    const normalizedUrl = this.normalizeUrl(url);
    this.logger.info('Starting website extraction', { url: normalizedUrl });

    const processedPages: ProcessedPage[] = [];
    const prefill: OnboardingPrefill = {};

    // Step 1-4: Fetch and process homepage
    try {
      const homepage = await this.fetchAndProcess(normalizedUrl);
      if (homepage) {
        processedPages.push(homepage);

        // Step 5: Follow about/social links (up to MAX_PAGES - 1 additional pages)
        const additionalUrls = this.findImportantLinks(homepage, normalizedUrl);
        const fetched = 1;
        for (const additionalUrl of additionalUrls.slice(0, MAX_PAGES_PER_DOMAIN - fetched)) {
          try {
            const page = await this.fetchAndProcess(additionalUrl);
            if (page) processedPages.push(page);
          } catch (err) {
            this.logger.debug('Failed to fetch additional page', {
              url: additionalUrl,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn('Homepage fetch failed', {
        url: normalizedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return empty prefill on total failure
      return prefill;
    }

    if (processedPages.length === 0) {
      return prefill;
    }

    // Step 6: LLM extraction
    let llmResult: LlmExtractionResult;
    try {
      llmResult = await this.callLlmExtraction(processedPages);
    } catch (err) {
      this.logger.warn('LLM extraction failed, returning metadata-only prefill', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: extract what we can from metadata alone
      return this.buildMetadataOnlyPrefill(processedPages);
    }

    // Step 7: Map LLM result to OnboardingPrefill with confidence
    return this.mapToPrefill(llmResult, processedPages);
  }

  // ---------------------------------------------------------------------------
  // Fetch & Process
  // ---------------------------------------------------------------------------

  /**
   * Fetch a URL and process the HTML into structured page data.
   *
   * @param url - URL to fetch
   * @returns Processed page data or null if fetch fails
   */
  async fetchAndProcess(url: string): Promise<ProcessedPage | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        this.logger.warn('Fetch returned non-OK status', { url, status: response.status });
        return null;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        this.logger.debug('Skipping non-HTML content', { url, contentType });
        return null;
      }

      let html = await response.text();
      if (html.length > MAX_CONTENT_LENGTH) {
        html = html.slice(0, MAX_CONTENT_LENGTH);
      }

      const metadata = this.extractMetadata(html);
      const textContent = this.extractVisibleText(html);
      const links = this.extractLinks(html, url);

      return { url, metadata, textContent, links };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.logger.warn('Fetch timed out', { url, timeoutMs: FETCH_TIMEOUT_MS });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------------------------------------------------------------------------
  // HTML Parsing (rule-based, no external dependencies)
  // ---------------------------------------------------------------------------

  /**
   * Extract metadata from HTML head section.
   *
   * @param html - Raw HTML string
   * @returns Extracted metadata
   */
  extractMetadata(html: string): PageMetadata {
    return {
      title: this.extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || '',
      description: this.extractMetaContent(html, 'description') || '',
      ogTitle: this.extractMetaProperty(html, 'og:title') || '',
      ogDescription: this.extractMetaProperty(html, 'og:description') || '',
      ogImage: this.extractMetaProperty(html, 'og:image') || '',
      ogSiteName: this.extractMetaProperty(html, 'og:site_name') || '',
      canonical: this.extractLinkHref(html, 'canonical') || '',
    };
  }

  /**
   * Extract visible text content from HTML, stripping all tags.
   * Removes scripts, styles, and navigation elements.
   *
   * @param html - Raw HTML string
   * @returns Clean text content
   */
  extractVisibleText(html: string): string {
    let text = html;

    // Remove script, style, nav, header, footer tags and content
    text = text.replace(/<(script|style|nav|header|footer|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode common HTML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();

    // Truncate to reasonable length for LLM context
    return text.slice(0, 10_000);
  }

  /**
   * Extract links from HTML, focusing on about/social/important pages.
   *
   * @param html - Raw HTML string
   * @param baseUrl - Base URL for resolving relative links
   * @returns Array of absolute URLs
   */
  extractLinks(html: string, baseUrl: string): string[] {
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
    const links: string[] = [];
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      try {
        const href = match[1];
        const absolute = new URL(href, baseUrl).href;
        links.push(absolute);
      } catch {
        // Skip invalid URLs
      }
    }

    return [...new Set(links)];
  }

  // ---------------------------------------------------------------------------
  // Link Analysis
  // ---------------------------------------------------------------------------

  /**
   * Find important links to follow (about, team, services pages, social profiles).
   *
   * @param page - Processed homepage data
   * @param baseUrl - Homepage URL for same-domain filtering
   * @returns Prioritized list of URLs to fetch
   */
  findImportantLinks(page: ProcessedPage, baseUrl: string): string[] {
    const baseHost = new URL(baseUrl).hostname;
    const important: string[] = [];
    const social: string[] = [];

    const aboutPatterns = /\b(about|team|services|products|our-story|company|who-we-are)\b/i;
    const socialPatterns = /\b(twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok)\b/i;

    for (const link of page.links) {
      try {
        const url = new URL(link);

        // Same-domain about/services pages
        if (url.hostname === baseHost && aboutPatterns.test(url.pathname)) {
          important.push(link);
        }

        // Social profiles (external)
        if (socialPatterns.test(url.hostname)) {
          social.push(link);
        }
      } catch {
        // Skip invalid URLs
      }
    }

    // Prioritize about pages, then social links
    return [...important.slice(0, 2), ...social.slice(0, 3)];
  }

  // ---------------------------------------------------------------------------
  // LLM Extraction
  // ---------------------------------------------------------------------------

  /**
   * Call Claude to extract structured brand profile data from page content.
   *
   * @param pages - Processed page data
   * @returns Structured extraction result
   */
  async callLlmExtraction(pages: ProcessedPage[]): Promise<LlmExtractionResult> {
    // Use injected LLM function if available (testing)
    if (this.llmExtractFn) {
      return this.llmExtractFn('', pages);
    }

    const { generateText } = await import('ai');
    const { anthropic } = await import('@ai-sdk/anthropic');

    const pageContext = pages.map((p, i) => {
      const meta = [
        p.metadata.title && `Title: ${p.metadata.title}`,
        p.metadata.description && `Description: ${p.metadata.description}`,
        p.metadata.ogSiteName && `Site Name: ${p.metadata.ogSiteName}`,
      ].filter(Boolean).join('\n');

      const socialLinks = p.links
        .filter((l) => /twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok/i.test(l))
        .slice(0, 5)
        .join(', ');

      return `--- Page ${i + 1}: ${p.url} ---\n${meta}\n\nContent:\n${p.textContent.slice(0, 4000)}\n${socialLinks ? `\nSocial Links: ${socialLinks}` : ''}`;
    }).join('\n\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    try {
      const result = await generateText({
        model: anthropic(EXTRACTION_MODEL),
        prompt: `You are a brand analyst. Extract brand profile information from the following website content.
Return a JSON object with these optional fields:
- businessName (string): Business or brand name
- industry (string): Industry or vertical
- description (string): One-sentence business description
- targetCustomer (string): Target customer demographic
- competitors (string[]): Competitor names
- personality (string[]): Brand personality words (3-5 adjectives)
- tone (string): Content tone — one of: formal, casual, playful, authoritative
- platforms (string[]): Active social media platforms
- goals (string[]): Inferred marketing goals
- contentExamples (string[]): Example content URLs or descriptions
- fieldConfidence (object): Map of field name → "high"|"medium"|"low"
  - "high" = explicitly stated on the page
  - "medium" = inferred from context
  - "low" = guessed from limited evidence

Rules:
- Only extract information clearly present or strongly inferable from the content.
- Set fieldConfidence for each field you include.
- Leave fields out entirely if you cannot find relevant information.
- Do NOT hallucinate — if unsure, omit the field.
- Return ONLY valid JSON, no markdown fences, no explanation.

Website Content:
${pageContext}`,
        abortSignal: controller.signal,
      });

      return this.parseLlmResponse(result.text);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse the LLM text response into a structured extraction result.
   * Handles JSON wrapped in markdown code fences.
   *
   * @param text - Raw LLM response text
   * @returns Parsed extraction result
   */
  parseLlmResponse(text: string): LlmExtractionResult {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned) as LlmExtractionResult;
      return parsed;
    } catch (err) {
      this.logger.warn('Failed to parse LLM JSON response', {
        textLength: text.length,
        preview: text.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Mapping & Confidence
  // ---------------------------------------------------------------------------

  /**
   * Map LLM extraction result to OnboardingPrefill with PrefillField wrappers.
   *
   * @param result - Raw LLM extraction result
   * @param pages - Source pages for URL attribution
   * @returns Structured OnboardingPrefill
   */
  mapToPrefill(result: LlmExtractionResult, pages: ProcessedPage[]): OnboardingPrefill {
    const sourceUrls = pages.map((p) => p.url);
    const confidence = result.fieldConfidence || {};
    const prefill: OnboardingPrefill = {};

    if (result.businessName) {
      prefill.businessName = this.createPrefillField(
        result.businessName, sourceUrls, confidence.businessName || 'medium',
      );
    }

    if (result.industry) {
      prefill.industry = this.createPrefillField(
        result.industry, sourceUrls, confidence.industry || 'medium',
      );
    }

    if (result.description) {
      prefill.description = this.createPrefillField(
        result.description, sourceUrls, confidence.description || 'medium',
      );
    }

    if (result.targetCustomer) {
      prefill.targetCustomer = this.createPrefillField(
        result.targetCustomer, sourceUrls, confidence.targetCustomer || 'low',
      );
    }

    if (result.competitors && result.competitors.length > 0) {
      prefill.competitors = this.createPrefillField(
        result.competitors, sourceUrls, confidence.competitors || 'low',
      );
    }

    if (result.personality && result.personality.length > 0) {
      prefill.personality = this.createPrefillField(
        result.personality, sourceUrls, confidence.personality || 'medium',
      );
    }

    if (result.tone) {
      prefill.tone = this.createPrefillField(
        result.tone, sourceUrls, confidence.tone || 'medium',
      );
    }

    if (result.platforms && result.platforms.length > 0) {
      prefill.platforms = this.createPrefillField(
        result.platforms, sourceUrls, confidence.platforms || 'high',
      );
    }

    if (result.goals && result.goals.length > 0) {
      prefill.goals = this.createPrefillField(
        result.goals, sourceUrls, confidence.goals || 'low',
      );
    }

    if (result.contentExamples && result.contentExamples.length > 0) {
      prefill.contentExamples = this.createPrefillField(
        result.contentExamples, sourceUrls, confidence.contentExamples || 'medium',
      );
    }

    return prefill;
  }

  /**
   * Build a metadata-only prefill when LLM extraction fails.
   * Uses page title, og tags, and social links as fallback.
   *
   * @param pages - Processed pages
   * @returns Partial OnboardingPrefill from metadata only
   */
  buildMetadataOnlyPrefill(pages: ProcessedPage[]): OnboardingPrefill {
    const prefill: OnboardingPrefill = {};
    const sourceUrls = pages.map((p) => p.url);
    const homepage = pages[0];

    if (!homepage) return prefill;

    // Business name from og:site_name or <title>
    const name = homepage.metadata.ogSiteName || homepage.metadata.title;
    if (name) {
      prefill.businessName = this.createPrefillField(name, sourceUrls, 'medium');
    }

    // Description from meta description or og:description
    const desc = homepage.metadata.ogDescription || homepage.metadata.description;
    if (desc) {
      prefill.description = this.createPrefillField(desc, sourceUrls, 'medium');
    }

    // Platforms from social links
    const socialLinks = pages.flatMap((p) => p.links)
      .filter((l) => /twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok/i.test(l));
    if (socialLinks.length > 0) {
      const platforms = this.detectPlatformsFromLinks(socialLinks);
      prefill.platforms = this.createPrefillField(platforms, socialLinks, 'high');
    }

    return prefill;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a PrefillField with the given value and confidence.
   *
   * @param value - Extracted value
   * @param sourceUrls - URLs from which this was extracted
   * @param confidence - Confidence level
   * @returns PrefillField wrapper
   */
  createPrefillField(
    value: string | string[],
    sourceUrls: string[],
    confidence: PrefillConfidence,
  ): PrefillField {
    return {
      value: Array.isArray(value) ? value.join(', ') : value,
      sourceUrls,
      confidence,
      extractionMethod: 'llm_text',
      needsReview: confidence !== 'high',
    };
  }

  /**
   * Detect platform names from social media URLs.
   *
   * @param links - Array of social media URLs
   * @returns Platform name strings
   */
  detectPlatformsFromLinks(links: string[]): string[] {
    const platforms = new Set<string>();
    for (const link of links) {
      if (/twitter\.com|x\.com/i.test(link)) platforms.add('X (Twitter)');
      if (/linkedin\.com/i.test(link)) platforms.add('LinkedIn');
      if (/facebook\.com/i.test(link)) platforms.add('Facebook');
      if (/instagram\.com/i.test(link)) platforms.add('Instagram');
      if (/youtube\.com/i.test(link)) platforms.add('YouTube');
      if (/tiktok\.com/i.test(link)) platforms.add('TikTok');
    }
    return [...platforms];
  }

  /**
   * Normalize a URL (add protocol if missing).
   *
   * @param url - Raw URL string
   * @returns Normalized URL with protocol
   */
  normalizeUrl(url: string): string {
    let normalized = url.trim();
    if (!normalized.match(/^https?:\/\//i)) {
      normalized = `https://${normalized}`;
    }
    return normalized;
  }

  // ---------------------------------------------------------------------------
  // Regex helpers for HTML parsing
  // ---------------------------------------------------------------------------

  /**
   * Extract text content matching a regex group from HTML.
   *
   * @param html - HTML string
   * @param regex - Regex with a capture group
   * @returns Captured text or empty string
   */
  private extractTag(html: string, regex: RegExp): string {
    const match = html.match(regex);
    return match?.[1]?.trim() || '';
  }

  /**
   * Extract content from a meta name tag.
   *
   * @param html - HTML string
   * @param name - Meta tag name attribute
   * @returns Content value or empty string
   */
  private extractMetaContent(html: string, name: string): string {
    const regex = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    if (match) return match[1]?.trim() || '';

    // Try reversed attribute order
    const regex2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`, 'i');
    const match2 = html.match(regex2);
    return match2?.[1]?.trim() || '';
  }

  /**
   * Extract content from a meta property (og:*) tag.
   *
   * @param html - HTML string
   * @param property - Meta tag property attribute
   * @returns Content value or empty string
   */
  private extractMetaProperty(html: string, property: string): string {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    if (match) return match[1]?.trim() || '';

    // Try reversed attribute order
    const regex2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, 'i');
    const match2 = html.match(regex2);
    return match2?.[1]?.trim() || '';
  }

  /**
   * Extract href from a link rel tag.
   *
   * @param html - HTML string
   * @param rel - Link rel attribute value
   * @returns Href value or empty string
   */
  private extractLinkHref(html: string, rel: string): string {
    const regex = new RegExp(`<link[^>]+rel=["']${rel}["'][^>]+href=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    if (match) return match[1]?.trim() || '';

    const regex2 = new RegExp(`<link[^>]+href=["']([^"']*)["'][^>]+rel=["']${rel}["']`, 'i');
    const match2 = html.match(regex2);
    return match2?.[1]?.trim() || '';
  }
}
