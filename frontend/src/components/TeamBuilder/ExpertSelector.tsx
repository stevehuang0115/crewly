/**
 * ExpertSelector Component
 *
 * Dropdown-based picker for selecting an expert profile on a team member.
 * Loads experts from GET /api/experts and optionally filters by baseRoles
 * to show only relevant experts for the member's current role.
 *
 * @module components/TeamBuilder/ExpertSelector
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/UI/Badge';
import { Card } from '@/components/UI/Card';
import { Button } from '@/components/UI/Button';
import { Dropdown } from '@/components/UI/Dropdown';
import { apiService } from '@/services/api.service';
import type { ExpertSummary } from '@/types/expert.types';

/** Props for the ExpertSelector component */
export interface ExpertSelectorProps {
  /** Currently selected expert ID (or undefined for none) */
  value?: string;
  /** Called when an expert is selected or cleared */
  onChange: (expertId: string | undefined) => void;
  /** Member role used to filter relevant experts. If omitted, all experts are shown. */
  memberRole?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
}

/**
 * Dropdown-based expert profile selector with role filtering.
 *
 * Fetches expert profiles from the API, filters them by the member's role
 * (matching against expert.baseRoles), and displays a dropdown for selection.
 * Shows the selected expert's category and tags when one is chosen.
 *
 * @param props - Component props
 * @returns ExpertSelector component
 *
 * @example
 * ```tsx
 * <ExpertSelector
 *   value={member.expertId}
 *   onChange={(id) => onUpdateMember(member.id, { expertId: id })}
 *   memberRole={member.role}
 * />
 * ```
 */
export const ExpertSelector: React.FC<ExpertSelectorProps> = ({
  value,
  onChange,
  memberRole,
  disabled = false,
}) => {
  const [experts, setExperts] = useState<ExpertSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Fetch expert profiles on mount */
  useEffect(() => {
    let cancelled = false;

    const fetchExperts = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await apiService.getExperts();
        if (!cancelled) {
          setExperts(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load experts');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchExperts();
    return () => { cancelled = true; };
  }, []);

  /**
   * Filter experts by memberRole if provided.
   * An expert matches if any of its baseRoles is a substring match
   * with the member's role (e.g., role "backend-developer" matches baseRole "backend-developer").
   */
  const filteredExperts = useMemo(() => {
    if (!memberRole) return experts;

    const roleLower = memberRole.toLowerCase();
    const matched = experts.filter((e) =>
      e.baseRoles.some((br) => roleLower.includes(br.toLowerCase()) || br.toLowerCase().includes(roleLower))
    );

    // If no matches for the role, show all experts so the user still has options
    return matched.length > 0 ? matched : experts;
  }, [experts, memberRole]);

  /** Build dropdown options from filtered experts */
  const dropdownOptions = useMemo(() => {
    return filteredExperts.map((e) => ({
      value: e.id,
      label: `${e.name} (${e.category})`,
    }));
  }, [filteredExperts]);

  /** Find the currently selected expert for detail display */
  const selectedExpert = useMemo(
    () => experts.find((e) => e.id === value),
    [experts, value],
  );

  /** Handle clearing the selection */
  const handleClear = useCallback(() => {
    onChange(undefined);
  }, [onChange]);

  /** Handle dropdown selection */
  const handleSelect = useCallback(
    (expertId: string) => {
      onChange(expertId);
    },
    [onChange],
  );

  if (error) {
    return (
      <div className="text-sm text-red-400" data-testid="expert-selector-error">
        {error}
      </div>
    );
  }

  return (
    <div data-testid="expert-selector">
      {/* Section header */}
      <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
        <Sparkles className="w-4 h-4" />
        Expert Profile
      </div>

      {/* Dropdown picker */}
      <Dropdown
        options={dropdownOptions}
        value={value}
        onChange={handleSelect}
        placeholder="Select an expert profile..."
        loading={loading}
        disabled={disabled}
        aria-label="Expert profile selector"
      />

      {/* Selected expert detail card */}
      {selectedExpert && (
        <Card variant="outlined" padding="sm" className="mt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium text-text-primary-dark text-sm">
              {selectedExpert.name}
            </span>
            <div className="flex items-center gap-2">
              <Badge variant="primary" size="sm">
                {selectedExpert.category}
              </Badge>
              {!disabled && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleClear}
                  aria-label="Clear expert selection"
                  data-testid="expert-clear-btn"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selectedExpert.tags.map((tag) => (
              <Badge key={tag} variant="default" size="sm">
                {tag}
              </Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

ExpertSelector.displayName = 'ExpertSelector';

export default ExpertSelector;
