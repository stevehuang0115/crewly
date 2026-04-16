/**
 * SourceDrawer Component
 *
 * Inline expandable drawer that shows the source evidence for an
 * AI-extracted field. Displays snippet, source URL, and extraction method.
 * Critical for building user trust and reducing hallucination anxiety.
 *
 * @module components/PortalOnboarding/SourceDrawer
 */

import React from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { PrefillConfidence, PrefillExtractionMethod } from '../../types/onboarding.types';
import { ConfidencePill } from './ConfidencePill';

export interface SourceDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean;
  /** Close handler */
  onClose: () => void;
  /** Field label */
  fieldLabel: string;
  /** Confidence level */
  confidence: PrefillConfidence;
  /** Source URLs used for extraction */
  sourceUrls: string[];
  /** Supporting text snippet */
  sourceSnippet?: string;
  /** How the value was extracted */
  extractionMethod: PrefillExtractionMethod;
}

/** Human-readable extraction method labels */
const METHOD_LABELS: Record<PrefillExtractionMethod, string> = {
  llm_text: 'Extracted from page text',
  llm_vision: 'Inferred from visual design',
  rule: 'Detected from page structure',
  manual: 'User confirmed',
};

/**
 * Renders an inline source disclosure drawer for a prefill field.
 *
 * @param props - Drawer configuration
 * @returns SourceDrawer element or null when closed
 */
export const SourceDrawer: React.FC<SourceDrawerProps> = ({
  isOpen,
  onClose,
  fieldLabel,
  confidence,
  sourceUrls,
  sourceSnippet,
  extractionMethod,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="mt-2 rounded-lg border border-border-dark bg-background-dark p-4 animate-in slide-in-from-top-2"
      data-testid="source-drawer"
      role="region"
      aria-label={`Source details for ${fieldLabel}`}
    >
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-text-primary-dark">
          Why we think this
        </h4>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-text-secondary-dark hover:text-text-primary-dark hover:bg-surface-dark transition-colors"
          aria-label="Close source details"
          data-testid="source-drawer-close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        {/* Confidence */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary-dark">Confidence:</span>
          <ConfidencePill confidence={confidence} />
        </div>

        {/* Snippet */}
        {sourceSnippet && (
          <div>
            <span className="text-xs text-text-secondary-dark block mb-1">
              Supporting snippet:
            </span>
            <blockquote className="border-l-2 border-primary/30 pl-3 text-sm text-text-primary-dark italic">
              {sourceSnippet}
            </blockquote>
          </div>
        )}

        {/* Sources */}
        {sourceUrls.length > 0 && (
          <div>
            <span className="text-xs text-text-secondary-dark block mb-1">
              Source pages:
            </span>
            <ul className="space-y-1">
              {sourceUrls.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {new URL(url).pathname || '/'}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Method */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary-dark">Method:</span>
          <span className="text-xs text-text-primary-dark">
            {METHOD_LABELS[extractionMethod]}
          </span>
        </div>
      </div>
    </div>
  );
};

SourceDrawer.displayName = 'SourceDrawer';
