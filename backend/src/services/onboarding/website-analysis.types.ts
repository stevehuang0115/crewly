/**
 * Website Analysis Types — structured brand extraction with confidence + provenance.
 *
 * Used by WebsiteAnalysisService for the KR3 "magic onboarding" pipeline:
 * URL → crawl → LLM extraction → structured AnalysisDraft → template recommendation.
 *
 * @module services/onboarding/website-analysis.types
 */

// ---------------------------------------------------------------------------
// Analysis Field (per-field confidence + source)
// ---------------------------------------------------------------------------

/** Confidence level for an extracted field. */
export type AnalysisConfidence = 'high' | 'medium' | 'low';

/**
 * Source provenance for an extracted field.
 * Tracks where the data came from for transparency and "Why we think this" UI.
 */
export interface AnalysisSource {
  /** URL of the page where the data was found */
  url: string;
  /** Relevant text snippet from the source page */
  snippet: string;
  /** Title of the source page */
  pageTitle?: string;
  /** How the data was extracted */
  extractionMethod: 'meta-tags' | 'heading' | 'paragraph' | 'llm-inference' | 'social-links';
}

/**
 * A single extracted field with confidence score and source citation.
 * Core building block for the AnalysisDraft.
 */
export interface AnalysisField {
  /** Extracted value */
  value: string;
  /** Confidence in the extracted value */
  confidence: AnalysisConfidence;
  /** Where this value was found */
  source: AnalysisSource;
}

// ---------------------------------------------------------------------------
// Analysis Draft (complete extraction result)
// ---------------------------------------------------------------------------

/**
 * Template recommendation based on extracted brand profile.
 */
export interface TemplateRecommendation {
  /** Recommended template ID */
  templateId: string;
  /** Auto-generated team name from business name */
  teamName: string;
  /** Confidence in the recommendation */
  confidence: AnalysisConfidence;
  /** Why this template was recommended */
  reason: string;
}

/**
 * Complete brand analysis draft produced by WebsiteAnalysisService.
 * Each field carries confidence + source provenance for the review UI.
 */
export interface AnalysisDraft {
  /** Business name */
  businessName?: AnalysisField;
  /** Industry / vertical */
  industry?: AnalysisField;
  /** One-sentence business description */
  description?: AnalysisField;
  /** Target customer profile */
  targetCustomer?: AnalysisField;
  /** Brand personality traits */
  brandPersonality?: AnalysisField;
  /** Content tone */
  tone?: AnalysisField;
  /** Marketing goals */
  goals?: AnalysisField;
  /** Active social platforms */
  platforms?: AnalysisField;
  /** Competitors */
  competitors?: AnalysisField;
  /** Recommended template setup */
  recommendedTemplate?: TemplateRecommendation;
  /** Fields that could not be extracted (need manual input) */
  missingFields: string[];
  /** Pages that were analyzed */
  pagesAnalyzed: Array<{ url: string; title: string }>;
}

// ---------------------------------------------------------------------------
// Analysis Progress (for streaming UI)
// ---------------------------------------------------------------------------

/** Stage names for the 4-stage progress UI. */
export type AnalysisStage =
  | 'fetching_homepage'
  | 'discovering_pages'
  | 'extracting_content'
  | 'generating_draft';

/**
 * Progress event emitted during website analysis.
 * Sent via SSE for real-time UI updates.
 */
export interface AnalysisProgressEvent {
  /** Current stage */
  stage: AnalysisStage;
  /** Human-readable status message */
  message: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Partial draft available so far (may be incomplete) */
  partialDraft?: Partial<AnalysisDraft>;
  /** Error message if current stage failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Analysis Options
// ---------------------------------------------------------------------------

/**
 * Options for initiating a website analysis.
 */
export interface AnalysisOptions {
  /** Website URL to analyze */
  url: string;
  /** Maximum number of pages to crawl (default: 5) */
  maxPages?: number;
  /** Overall timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Progress callback for streaming updates */
  onProgress?: (event: AnalysisProgressEvent) => void;
}

/**
 * Complete result of a website analysis including metadata.
 */
export interface AnalysisResult {
  /** Whether the analysis completed successfully */
  success: boolean;
  /** The extracted draft (may be partial on failure) */
  draft: AnalysisDraft;
  /** Total time taken in milliseconds */
  durationMs: number;
  /** Number of pages fetched */
  pagesFetched: number;
  /** Error message if analysis failed */
  error?: string;
}
