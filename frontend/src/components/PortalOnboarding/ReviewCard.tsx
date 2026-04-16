/**
 * ReviewCard Component
 *
 * A card grouping related AI-extracted fields for review.
 * Contains a title, icon, and a list of EditableFieldRow components.
 * Stagger-animates in on mount for visual polish.
 *
 * @module components/PortalOnboarding/ReviewCard
 */

import React from 'react';
import { Building2, Users, Globe, Sparkles, LucideIcon } from 'lucide-react';
import type { OnboardingPrefill, PrefillField, ReviewCardConfig } from '../../types/onboarding.types';
import { EditableFieldRow } from './EditableFieldRow';

export interface ReviewCardProps {
  /** Card configuration (title, icon, fields) */
  config: ReviewCardConfig;
  /** Prefill data */
  prefill: OnboardingPrefill;
  /** Set of field keys that have been manually edited */
  editedFields: Set<string>;
  /** Called when a field value is edited */
  onFieldEdit: (key: keyof OnboardingPrefill, value: string | string[]) => void;
  /** Called when a field is reset to AI draft */
  onFieldReset: (key: keyof OnboardingPrefill) => void;
  /** Animation delay index for stagger effect */
  index?: number;
}

/** Icon map by name */
const ICON_MAP: Record<string, LucideIcon> = {
  Building2,
  Users,
  Globe,
  Sparkles,
};

/**
 * Renders a review card with grouped editable fields.
 *
 * @param props - Card configuration and data
 * @returns ReviewCard element
 */
export const ReviewCard: React.FC<ReviewCardProps> = ({
  config,
  prefill,
  editedFields,
  onFieldEdit,
  onFieldReset,
  index = 0,
}) => {
  const Icon = ICON_MAP[config.icon] ?? Building2;

  return (
    <div
      className="rounded-xl border border-border-dark bg-surface-dark overflow-hidden transition-all duration-300"
      style={{ animationDelay: `${index * 100}ms` }}
      data-testid={`review-card-${config.title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      {/* Card header */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border-dark/50">
        <Icon className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold text-text-primary-dark">
          {config.title}
        </h3>
      </div>

      {/* Field rows */}
      <div className="px-6">
        {config.fields.map((fieldConfig) => {
          const fieldData = prefill[fieldConfig.key] as PrefillField | undefined;
          const isEdited = editedFields.has(fieldConfig.key);

          return (
            <EditableFieldRow
              key={fieldConfig.key}
              label={fieldConfig.label}
              field={fieldData ?? null}
              required={fieldConfig.required}
              isEdited={isEdited}
              onEdit={(value) => onFieldEdit(fieldConfig.key, value)}
              onReset={() => onFieldReset(fieldConfig.key)}
            />
          );
        })}
      </div>
    </div>
  );
};

ReviewCard.displayName = 'ReviewCard';
