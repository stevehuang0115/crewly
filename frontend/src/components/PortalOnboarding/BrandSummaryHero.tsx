/**
 * BrandSummaryHero Component
 *
 * Top summary hero for the Review AI Draft screen (Screen 3).
 * Shows company name, favicon/monogram, industry, AI summary, and draft status.
 *
 * @module components/PortalOnboarding/BrandSummaryHero
 */

import React from 'react';
import { Globe } from 'lucide-react';
import { Badge } from '../UI/Badge';

// =============================================================================
// Types
// =============================================================================

export type DraftStatus = 'high' | 'mixed' | 'needs-review';

export interface BrandSummaryHeroProps {
  /** Company name from AI extraction */
  companyName: string;
  /** Website URL analyzed */
  websiteUrl: string;
  /** Industry category */
  industry?: string;
  /** One-line description */
  description?: string;
  /** Overall draft confidence status */
  status: DraftStatus;
  /** Optional favicon URL */
  faviconUrl?: string;
  /** Fallback monogram (first letter) */
  monogram?: string;
}

// =============================================================================
// Constants
// =============================================================================

const STATUS_CONFIG: Record<DraftStatus, { label: string; variant: 'success' | 'warning' | 'default' }> = {
  high: { label: 'High confidence draft', variant: 'success' },
  mixed: { label: 'Draft needs review', variant: 'warning' },
  'needs-review': { label: 'Review required', variant: 'warning' },
};

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the brand summary hero card at the top of the review screen.
 * Displays extracted company identity and draft quality status.
 *
 * @param props - Component props
 * @returns BrandSummaryHero element
 */
export const BrandSummaryHero: React.FC<BrandSummaryHeroProps> = ({
  companyName,
  websiteUrl,
  industry,
  description,
  status,
  faviconUrl,
  monogram,
}) => {
  const statusInfo = STATUS_CONFIG[status];
  const displayMonogram = monogram ?? companyName.charAt(0).toUpperCase();

  return (
    <div
      className="rounded-xl bg-surface-dark border border-border-dark p-6 mb-6"
      data-testid="brand-summary-hero"
    >
      <div className="flex items-start gap-4">
        {/* Favicon / Monogram */}
        <div className="flex-shrink-0">
          {faviconUrl ? (
            <img
              src={faviconUrl}
              alt={`${companyName} favicon`}
              className="h-12 w-12 rounded-lg object-contain bg-background-dark"
              data-testid="brand-favicon"
            />
          ) : (
            <div
              className="h-12 w-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-lg font-bold"
              data-testid="brand-monogram"
            >
              {displayMonogram}
            </div>
          )}
        </div>

        {/* Company info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-xl font-bold text-text-primary-dark" data-testid="brand-name">
              {companyName}
            </h2>
            {industry && (
              <span className="text-sm text-text-secondary-dark" data-testid="brand-industry">
                {industry}
              </span>
            )}
            <Badge
              variant={statusInfo.variant}
              size="sm"
              data-testid="brand-status-badge"
            >
              {statusInfo.label}
            </Badge>
          </div>

          {description && (
            <p className="mt-1 text-sm text-text-secondary-dark" data-testid="brand-description">
              {description}
            </p>
          )}

          <div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary-dark/70">
            <Globe className="h-3.5 w-3.5" />
            <span data-testid="brand-url">{websiteUrl}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

BrandSummaryHero.displayName = 'BrandSummaryHero';
