/**
 * Website Analysis Service — Independent, Reusable Brand Extraction Pipeline
 *
 * Analyzes a website URL and produces a structured AnalysisDraft with per-field
 * confidence scores and source provenance. Designed for KR3 "magic onboarding"
 * but intentionally independent of the onboarding flow for reuse in template
 * previews, competitor analysis, and brand profile updates.
 *
 * Pipeline (4 stages with streaming progress):
 * 1. Fetch homepage — DNS/SSL/redirect handling, robots.txt respect
 * 2. Discover pages — find about/services/products/team pages (same-domain)
 * 3. Extract content — HTML-to-text, metadata extraction from all pages
 * 4. Generate draft — LLM structured extraction with confidence + source
 *
 * @module services/onboarding/website-analysis.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WebsiteExtractorService, type ProcessedPage, type LlmExtractionResult } from './website-extractor.service.js';
import type {
  AnalysisDraft,
  AnalysisField,
  AnalysisConfidence,
  AnalysisSource,
  AnalysisOptions,
  AnalysisResult,
  AnalysisProgressEvent,
  AnalysisStage,
  TemplateRecommendation,
} from './website-analysis.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum pages to crawl per analysis */
const DEFAULT_MAX_PAGES = 5;

/** Default overall timeout for the full analysis pipeline */
const DEFAULT_TIMEOUT_MS = 30_000;

/** All brand fields we attempt to extract */
const BRAND_FIELDS = [
  'businessName',
  'industry',
  'description',
  'targetCustomer',
  'brandPersonality',
  'tone',
  'goals',
  'platforms',
  'competitors',
] as const;

/** Industry → template ID mapping for rule-based recommendations */
const INDUSTRY_TEMPLATE_MAP: Record<string, string> = {
  marketing: 'pro-marketing-team',
  'digital marketing': 'pro-marketing-team',
  advertising: 'pro-marketing-team',
  'social media': 'pro-social-media-ops',
  'content creation': 'pro-content-generation',
  education: 'pro-education-smb',
  insurance: 'pro-insurance-smb',
  software: 'pro-dev-fullstack',
  technology: 'pro-dev-fullstack',
  saas: 'pro-dev-fullstack',
  research: 'pro-research-analysis',
  consulting: 'pro-research-analysis',
  'e-commerce': 'pro-marketing-team',
  retail: 'pro-marketing-team',
};

/** Default template when industry doesn't match */
const DEFAULT_TEMPLATE_ID = 'pro-marketing-team';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * WebsiteAnalysisService provides an independent, reusable pipeline for
 * extracting structured brand data from a website URL.
 *
 * Uses WebsiteExtractorService for low-level fetching/parsing, then adds:
 * - Structured AnalysisDraft output with per-field confidence + source
 * - 4-stage streaming progress events
 * - Template recommendation based on extracted profile
 * - Partial results on failure (graceful degradation)
 *
 * @example
 * ```typescript
 * const service = WebsiteAnalysisService.getInstance();
 * const result = await service.analyze({
 *   url: 'https://example.com',
 *   onProgress: (event) => console.log(event.stage, event.progress),
 * });
 * ```
 */
export class WebsiteAnalysisService {
  private static instance: WebsiteAnalysisService | null = null;
  private readonly logger: ComponentLogger;
  private extractor: WebsiteExtractorService;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('WebsiteAnalysis');
    this.extractor = WebsiteExtractorService.getInstance();
  }

  /**
   * Get the singleton instance.
   *
   * @returns WebsiteAnalysisService instance
   */
  static getInstance(): WebsiteAnalysisService {
    if (!WebsiteAnalysisService.instance) {
      WebsiteAnalysisService.instance = new WebsiteAnalysisService();
    }
    return WebsiteAnalysisService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    WebsiteAnalysisService.instance = null;
  }

  /**
   * Override the extractor (for testing).
   *
   * @param extractor - Custom WebsiteExtractorService instance
   */
  setExtractor(extractor: WebsiteExtractorService): void {
    this.extractor = extractor;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze a website and produce a structured AnalysisDraft.
   *
   * Runs the 4-stage pipeline with streaming progress events.
   * Returns partial results on failure (graceful degradation).
   *
   * @param options - Analysis options including URL and progress callback
   * @returns Analysis result with draft, timing, and metadata
   */
  async analyze(options: AnalysisOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const emit = options.onProgress ?? (() => {});

    const draft: AnalysisDraft = {
      missingFields: [],
      pagesAnalyzed: [],
    };

    // Global timeout controller
    const controller = new AbortController();
    const globalTimeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Stage 1: Fetch homepage
      emit(this.createProgress('fetching_homepage', 'Reading homepage...', 10));

      const normalizedUrl = this.normalizeUrl(options.url);
      let homepage: ProcessedPage | null = null;

      try {
        homepage = await this.extractor.fetchAndProcess(normalizedUrl);
      } catch (err) {
        const error = `Failed to fetch homepage: ${err instanceof Error ? err.message : String(err)}`;
        emit(this.createProgress('fetching_homepage', error, 10, undefined, error));
        return this.buildResult(false, draft, startTime, 0, error);
      }

      if (!homepage) {
        const error = 'Homepage returned no content';
        emit(this.createProgress('fetching_homepage', error, 10, undefined, error));
        return this.buildResult(false, draft, startTime, 0, error);
      }

      draft.pagesAnalyzed.push({
        url: homepage.url,
        title: homepage.metadata.title || normalizedUrl,
      });

      if (controller.signal.aborted) {
        return this.buildResult(false, draft, startTime, 1, 'Analysis timed out during homepage fetch');
      }

      // Stage 2: Discover and crawl additional pages
      emit(this.createProgress('discovering_pages', 'Finding about, services, and team pages...', 30));

      const allPages: ProcessedPage[] = [homepage];
      const additionalUrls = this.extractor.findImportantLinks(homepage, normalizedUrl);

      for (const additionalUrl of additionalUrls.slice(0, maxPages - 1)) {
        if (controller.signal.aborted) break;

        try {
          const page = await this.extractor.fetchAndProcess(additionalUrl);
          if (page) {
            allPages.push(page);
            draft.pagesAnalyzed.push({
              url: page.url,
              title: page.metadata.title || additionalUrl,
            });
          }
        } catch {
          // Skip failed pages, continue with what we have
        }
      }

      emit(this.createProgress(
        'discovering_pages',
        `Found ${allPages.length} page${allPages.length > 1 ? 's' : ''}`,
        50,
      ));

      if (controller.signal.aborted) {
        return this.buildResult(false, draft, startTime, allPages.length, 'Analysis timed out during page discovery');
      }

      // Stage 3: Extract content (already done by fetchAndProcess — this stage is for progress)
      emit(this.createProgress('extracting_content', 'Analyzing page content...', 60));

      // Build metadata-only partial draft as fallback
      this.enrichDraftFromMetadata(draft, allPages);

      emit(this.createProgress('extracting_content', 'Content extracted', 70, { ...draft }));

      if (controller.signal.aborted) {
        this.identifyMissingFields(draft);
        return this.buildResult(false, draft, startTime, allPages.length, 'Analysis timed out during extraction');
      }

      // Stage 4: LLM extraction
      emit(this.createProgress('generating_draft', 'AI is drafting your brand profile...', 80));

      try {
        const llmResult = await this.extractor.callLlmExtraction(allPages);
        this.mapLlmResultToDraft(draft, llmResult, allPages);
      } catch (err) {
        this.logger.warn('LLM extraction failed, using metadata-only draft', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep the metadata-only draft as fallback
      }

      // Add template recommendation
      draft.recommendedTemplate = this.recommendTemplate(draft);

      // Identify missing fields
      this.identifyMissingFields(draft);

      emit(this.createProgress('generating_draft', 'Draft complete!', 100, { ...draft }));

      return this.buildResult(true, draft, startTime, allPages.length);
    } finally {
      clearTimeout(globalTimeout);
    }
  }

  // ---------------------------------------------------------------------------
  // Draft Building Helpers
  // ---------------------------------------------------------------------------

  /**
   * Enrich the draft with data from page metadata (title, og tags, meta description).
   * Used as fallback when LLM extraction is unavailable.
   *
   * @param draft - Draft to enrich
   * @param pages - Processed pages with metadata
   */
  private enrichDraftFromMetadata(draft: AnalysisDraft, pages: ProcessedPage[]): void {
    const homepage = pages[0];
    if (!homepage) return;

    const { metadata } = homepage;

    // Business name from og:site_name or title
    const businessName = metadata.ogSiteName || metadata.title?.split(/[|\-–—]/)[0]?.trim();
    if (businessName) {
      draft.businessName = this.createField(
        businessName,
        'medium',
        homepage.url,
        metadata.ogSiteName ? `og:site_name: "${metadata.ogSiteName}"` : `Page title: "${metadata.title}"`,
        homepage.metadata.title,
        metadata.ogSiteName ? 'meta-tags' : 'heading',
      );
    }

    // Description from meta description or og:description
    const description = metadata.description || metadata.ogDescription;
    if (description) {
      draft.description = this.createField(
        description,
        'medium',
        homepage.url,
        `Meta description: "${description.slice(0, 100)}..."`,
        homepage.metadata.title,
        'meta-tags',
      );
    }

    // Check about page for richer context
    const aboutPage = pages.find((p) =>
      p.url.includes('/about') || p.url.includes('/who-we-are'),
    );
    if (aboutPage && aboutPage.textContent) {
      const aboutSnippet = aboutPage.textContent.slice(0, 300).trim();
      if (aboutSnippet && !draft.description) {
        draft.description = this.createField(
          aboutSnippet,
          'low',
          aboutPage.url,
          `About page: "${aboutSnippet.slice(0, 100)}..."`,
          aboutPage.metadata.title,
          'paragraph',
        );
      }
    }
  }

  /**
   * Map LLM extraction result to AnalysisDraft fields with confidence + source.
   *
   * @param draft - Draft to populate
   * @param result - Raw LLM extraction result
   * @param pages - Source pages for provenance
   */
  private mapLlmResultToDraft(
    draft: AnalysisDraft,
    result: LlmExtractionResult,
    pages: ProcessedPage[],
  ): void {
    const confidence = result.fieldConfidence ?? {};
    const homepageUrl = pages[0]?.url ?? '';
    const homepageTitle = pages[0]?.metadata.title ?? '';

    const mapField = (
      value: string | string[] | undefined,
      fieldName: string,
    ): AnalysisField | undefined => {
      if (!value) return undefined;
      const strValue = Array.isArray(value) ? value.join(', ') : value;
      if (!strValue.trim()) return undefined;

      return this.createField(
        strValue,
        (confidence[fieldName] as AnalysisConfidence) ?? 'medium',
        homepageUrl,
        `LLM extracted: "${strValue.slice(0, 80)}..."`,
        homepageTitle,
        'llm-inference',
      );
    };

    // Map each field, preferring LLM result over metadata fallback
    draft.businessName = mapField(result.businessName, 'businessName') ?? draft.businessName;
    draft.industry = mapField(result.industry, 'industry') ?? draft.industry;
    draft.description = mapField(result.description, 'description') ?? draft.description;
    draft.targetCustomer = mapField(result.targetCustomer, 'targetCustomer') ?? draft.targetCustomer;
    draft.brandPersonality = mapField(result.personality, 'personality') ?? draft.brandPersonality;
    draft.tone = mapField(result.tone, 'tone') ?? draft.tone;
    draft.goals = mapField(result.goals, 'goals') ?? draft.goals;
    draft.platforms = mapField(result.platforms, 'platforms') ?? draft.platforms;
    draft.competitors = mapField(result.competitors, 'competitors') ?? draft.competitors;
  }

  /**
   * Identify fields that were not extracted and add to missingFields.
   *
   * @param draft - Draft to check
   */
  private identifyMissingFields(draft: AnalysisDraft): void {
    draft.missingFields = [];
    for (const field of BRAND_FIELDS) {
      if (!draft[field]) {
        draft.missingFields.push(field);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Template Recommendation
  // ---------------------------------------------------------------------------

  /**
   * Recommend a template based on the extracted brand profile.
   * Uses rule-based industry matching (can evolve to LLM-based later).
   *
   * @param draft - Current analysis draft
   * @returns Template recommendation with confidence and reason
   */
  recommendTemplate(draft: AnalysisDraft): TemplateRecommendation {
    const industry = draft.industry?.value?.toLowerCase() ?? '';
    const businessName = draft.businessName?.value ?? 'My Team';

    // Try direct industry match
    for (const [keyword, templateId] of Object.entries(INDUSTRY_TEMPLATE_MAP)) {
      if (industry.includes(keyword)) {
        return {
          templateId,
          teamName: `${businessName} AI Team`,
          confidence: 'high',
          reason: `Industry "${industry}" matches the ${templateId} template`,
        };
      }
    }

    // Check for social media / content keywords in description or goals
    const desc = draft.description?.value?.toLowerCase() ?? '';
    const goals = draft.goals?.value?.toLowerCase() ?? '';
    const combined = `${desc} ${goals}`;

    if (combined.includes('social media') || combined.includes('content')) {
      return {
        templateId: 'pro-social-media-ops',
        teamName: `${businessName} Social Team`,
        confidence: 'medium',
        reason: 'Brand profile mentions social media or content creation',
      };
    }

    // Default recommendation
    return {
      templateId: DEFAULT_TEMPLATE_ID,
      teamName: `${businessName} AI Team`,
      confidence: 'low',
      reason: 'Default recommendation — industry-specific template not found',
    };
  }

  // ---------------------------------------------------------------------------
  // Utility Helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a progress event for streaming UI updates.
   *
   * @param stage - Current pipeline stage
   * @param message - Human-readable status message
   * @param progress - Percentage complete (0-100)
   * @param partialDraft - Optional partial draft
   * @param error - Optional error message
   * @returns Progress event
   */
  private createProgress(
    stage: AnalysisStage,
    message: string,
    progress: number,
    partialDraft?: Partial<AnalysisDraft>,
    error?: string,
  ): AnalysisProgressEvent {
    return { stage, message, progress, partialDraft, error };
  }

  /**
   * Create an AnalysisField with full provenance.
   *
   * @param value - Extracted value
   * @param confidence - Confidence level
   * @param url - Source page URL
   * @param snippet - Relevant source snippet
   * @param pageTitle - Source page title
   * @param method - Extraction method
   * @returns Complete AnalysisField
   */
  private createField(
    value: string,
    confidence: AnalysisConfidence,
    url: string,
    snippet: string,
    pageTitle: string | undefined,
    method: AnalysisSource['extractionMethod'],
  ): AnalysisField {
    return {
      value,
      confidence,
      source: {
        url,
        snippet,
        pageTitle: pageTitle ?? undefined,
        extractionMethod: method,
      },
    };
  }

  /**
   * Normalize a URL: add protocol if missing, ensure trailing format.
   *
   * @param url - Raw URL input
   * @returns Normalized URL with protocol
   */
  private normalizeUrl(url: string): string {
    let normalized = url.trim();
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `https://${normalized}`;
    }
    return normalized;
  }

  /**
   * Build the final AnalysisResult object.
   *
   * @param success - Whether analysis completed successfully
   * @param draft - The analysis draft
   * @param startTime - Pipeline start timestamp
   * @param pagesFetched - Number of pages fetched
   * @param error - Optional error message
   * @returns Complete analysis result
   */
  private buildResult(
    success: boolean,
    draft: AnalysisDraft,
    startTime: number,
    pagesFetched: number,
    error?: string,
  ): AnalysisResult {
    return {
      success,
      draft,
      durationMs: Date.now() - startTime,
      pagesFetched,
      error,
    };
  }
}
