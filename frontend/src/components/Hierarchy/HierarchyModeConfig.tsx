/**
 * HierarchyModeConfig Component
 *
 * Configuration panel for enabling/disabling hierarchical team mode.
 * When enabled, allows selecting a Team Leader and configuring
 * hierarchy-related settings.
 *
 * Used within team creation and team edit flows.
 *
 * @module components/Hierarchy/HierarchyModeConfig
 */

import React, { useCallback } from 'react';
import { Shield, Users, ChevronRight, Check } from 'lucide-react';
import { Toggle } from '@crewly/ui/Toggle';
import type { TeamMember } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface HierarchyConfig {
  /** Whether hierarchical mode is enabled */
  hierarchical: boolean;
  /** @deprecated Use leaderIds. Retained for backward compatibility. */
  leaderId: string | null;
  /** Selected team leader member IDs (supports multiple TLs). */
  leaderIds?: string[];
}

export interface HierarchyModeConfigProps {
  /** Current hierarchy configuration */
  config: HierarchyConfig;
  /** Callback when configuration changes */
  onChange: (config: HierarchyConfig) => void;
  /** Available members that can be selected as team leader */
  members: TeamMember[];
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Filter members eligible for team leader role.
 * Any member except those already marked as pure workers (hierarchyLevel=2+)
 * can be a TL.
 *
 * @param members - All team members
 * @returns Members eligible for team leader
 */
export function getEligibleLeaders(members: TeamMember[]): TeamMember[] {
  return members.filter(m => m.role !== 'orchestrator');
}

// =============================================================================
// Component
// =============================================================================

/**
 * HierarchyModeConfig provides a toggle for hierarchical team management
 * and a leader selection dropdown when enabled.
 *
 * @param config - Current hierarchy configuration
 * @param onChange - Called when config changes
 * @param members - Available team members for leader selection
 * @param className - Additional CSS classes
 * @returns Configuration panel component
 *
 * @example
 * ```tsx
 * <HierarchyModeConfig
 *   config={{ hierarchical: false, leaderId: null }}
 *   onChange={(cfg) => setHierarchyConfig(cfg)}
 *   members={team.members}
 * />
 * ```
 */
export const HierarchyModeConfig: React.FC<HierarchyModeConfigProps> = ({
  config,
  onChange,
  members,
  className = '',
}) => {
  const eligibleLeaders = getEligibleLeaders(members);

  const currentLeaderIds = config.leaderIds ?? (config.leaderId ? [config.leaderId] : []);

  const handleToggle = useCallback(() => {
    onChange({
      hierarchical: !config.hierarchical,
      leaderId: !config.hierarchical ? config.leaderId : null,
      leaderIds: !config.hierarchical ? config.leaderIds : [],
    });
  }, [config, onChange]);

  /** Toggle a member's leader status on/off. */
  const handleLeaderToggle = useCallback(
    (memberId: string) => {
      const isSelected = currentLeaderIds.includes(memberId);
      const newIds = isSelected
        ? currentLeaderIds.filter(id => id !== memberId)
        : [...currentLeaderIds, memberId];
      onChange({
        ...config,
        leaderIds: newIds,
        leaderId: newIds[0] ?? null,
      });
    },
    [config, currentLeaderIds, onChange]
  );

  return (
    <div className={`rounded-lg border border-border-dark p-4 ${className}`} data-testid="hierarchy-mode-config">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-primary/10">
            <Users size={18} className="text-primary" />
          </div>
          <div>
            <h4 className="text-sm font-medium text-text-primary-dark">
              Hierarchical Mode
            </h4>
            <p className="text-xs text-text-secondary-dark">
              Enable Team Leader management with delegation
            </p>
          </div>
        </div>

        <Toggle
          size="lg"
          role="switch"
          aria-checked={config.hierarchical}
          aria-label="Toggle hierarchical mode"
          checked={config.hierarchical}
          onChange={handleToggle}
        />
      </div>

      {/* Leader selection (visible when hierarchical mode is enabled) */}
      {config.hierarchical && (
        <div className="mt-4 pt-4 border-t border-border-dark">
          <label
            className="flex items-center gap-2 text-sm font-medium text-text-primary-dark mb-2"
          >
            <Shield size={14} className="text-text-secondary-dark" />
            Team Leaders
            <span className="text-xs font-normal text-text-secondary-dark">(select one or more)</span>
          </label>

          {eligibleLeaders.length === 0 ? (
            <p className="text-xs text-text-secondary-dark" data-testid="no-leaders-message">
              Add team members first, then select leaders.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" data-testid="leader-select">
              {eligibleLeaders.map(m => {
                const isSelected = currentLeaderIds.includes(m.id);
                const isPrimary = currentLeaderIds[0] === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleLeaderToggle(m.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      isSelected
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'bg-background-dark border-border-dark text-text-secondary-dark hover:border-primary/50 hover:text-text-primary-dark'
                    }`}
                    data-testid={`leader-toggle-${m.id}`}
                  >
                    {isSelected && (
                      <Check className="w-3 h-3" />
                    )}
                    {m.name} ({m.role})
                    {isPrimary && isSelected && (
                      <span className="text-[10px] bg-primary/20 px-1 rounded">Primary</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Hierarchy preview */}
          {currentLeaderIds.length > 0 && (
            <div className="mt-3 p-3 rounded-md bg-background-dark/50" data-testid="hierarchy-preview">
              <p className="text-xs text-text-secondary-dark mb-2">Hierarchy preview:</p>
              {currentLeaderIds.map(lid => {
                const leader = members.find(m => m.id === lid);
                const workerCount = members.filter(
                  m => !currentLeaderIds.includes(m.id) && m.role !== 'orchestrator'
                ).length;
                return (
                  <div key={lid} className="flex items-center gap-1 text-xs text-text-primary-dark mb-1">
                    <span className="font-medium">Orchestrator</span>
                    <ChevronRight size={12} className="text-text-secondary-dark" />
                    <span className="font-medium text-primary">
                      {leader?.name ?? 'TL'}
                    </span>
                    {currentLeaderIds.length === 1 && (
                      <>
                        <ChevronRight size={12} className="text-text-secondary-dark" />
                        <span className="text-text-secondary-dark">
                          {workerCount} workers
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
              {currentLeaderIds.length > 1 && (
                <div className="flex items-center gap-1 text-xs text-text-secondary-dark mt-1">
                  <span>
                    {members.filter(m => !currentLeaderIds.includes(m.id) && m.role !== 'orchestrator').length} workers
                    (assign via member parentMemberId)
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

HierarchyModeConfig.displayName = 'HierarchyModeConfig';
