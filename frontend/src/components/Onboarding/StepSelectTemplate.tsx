/**
 * Step 2: Select Industry Template
 *
 * Displays available team templates in a card grid.
 * User selects one template to pre-configure their first team.
 *
 * @module components/Onboarding/StepSelectTemplate
 */

import React, { useState, useEffect } from 'react';
import {
  Laptop,
  Megaphone,
  Microscope,
  Smartphone,
  Video,
  GraduationCap,
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  Loader2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { TemplateInfo } from './onboarding.types';

// ---------------------------------------------------------------------------
// Icon mapping
// ---------------------------------------------------------------------------

/** Map template icon identifiers to Lucide components */
const ICON_MAP: Record<string, LucideIcon> = {
  laptop: Laptop,
  microscope: Microscope,
  smartphone: Smartphone,
  video: Video,
  'graduation-cap': GraduationCap,
  shield: ShieldCheck,
};

/**
 * Resolve a template's icon field to a Lucide component.
 *
 * @param icon - Icon identifier string
 * @returns Matching Lucide icon or a default
 */
function resolveIcon(icon: string): LucideIcon {
  if (ICON_MAP[icon]) return ICON_MAP[icon];
  // Fallback for emoji-style icons — use Megaphone as default for marketing/content
  return Megaphone;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StepSelectTemplateProps {
  /** Currently selected template (null if none) */
  selected: TemplateInfo | null;
  /** Callback when a template is selected */
  onSelect: (template: TemplateInfo) => void;
  /** Proceed to next step */
  onNext: () => void;
  /** Go back to previous step */
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Template selection grid showing available team templates.
 *
 * Fetches templates from GET /api/templates on mount.
 *
 * @param props - {@link StepSelectTemplateProps}
 * @returns Template selection step
 */
export const StepSelectTemplate: React.FC<StepSelectTemplateProps> = ({
  selected,
  onSelect,
  onNext,
  onBack,
}) => {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Fetch templates on mount */
  useEffect(() => {
    let cancelled = false;

    const fetchTemplates = async () => {
      try {
        const res = await fetch('/api/templates');
        if (!res.ok) throw new Error('Failed to load templates');
        const data = await res.json();
        if (!cancelled) {
          const list = data.data || data.templates || data || [];
          setTemplates(Array.isArray(list) ? list : []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load templates');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchTemplates();
    return () => { cancelled = true; };
  }, []);

  return (
    <div data-testid="step-select-template">
      {/* Heading */}
      <h3 className="text-xl font-bold mb-1">Choose a Team Template</h3>
      <p className="text-sm text-text-secondary-dark mb-6">
        Pick a pre-configured team for your industry. You can customize members in the next step.
      </p>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
          <span className="ml-2 text-sm text-text-secondary-dark">Loading templates...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-8 text-red-400 text-sm" role="alert">
          {error}
        </div>
      )}

      {/* Template Grid */}
      {!loading && !error && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[280px] overflow-y-auto pr-1">
          {templates.map(template => {
            const Icon = resolveIcon(template.icon);
            const isSelected = selected?.id === template.id;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                data-testid={`template-card-${template.id}`}
                className={clsx(
                  'flex items-start gap-3 p-4 rounded-lg border text-left transition-all',
                  isSelected
                    ? 'border-primary bg-primary/10 ring-1 ring-primary'
                    : 'border-border-dark bg-surface-dark hover:border-primary/50 hover:bg-surface-dark/80',
                )}
              >
                <div
                  className={clsx(
                    'flex items-center justify-center w-10 h-10 rounded-lg flex-shrink-0',
                    isSelected ? 'bg-primary/20 text-primary' : 'bg-background-dark text-text-secondary-dark',
                  )}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary-dark truncate">
                    {template.name}
                  </p>
                  <p className="text-xs text-text-secondary-dark line-clamp-2 mt-0.5">
                    {template.description}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-dark text-text-secondary-dark">
                      {template.roles?.length ?? 0} roles
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-dark text-text-secondary-dark capitalize">
                      {template.category}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-text-secondary-dark hover:text-text-primary-dark transition-colors"
          data-testid="template-back-btn"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!selected}
          className="flex items-center gap-2 px-6 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="template-next-btn"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default StepSelectTemplate;
