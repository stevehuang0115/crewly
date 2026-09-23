/**
 * EntityActionPanel - Bottom-center overlay with action buttons for commanding entities.
 *
 * When an entity is selected in boss mode (manual), this panel displays
 * action buttons that override the entity's current plan. Each button
 * sends an EntityCommand through the FactoryContext command channel.
 */

import React from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { useFactory } from '../../../contexts/FactoryContext';
import type { PlanStepType } from '../Agents/agentPlanTypes';

// ====== ACTION DEFINITIONS ======

/**
 * Action button configuration
 */
interface ActionDef {
  /** Display label on the button */
  label: string;
  /** Plan step type to command */
  stepType: PlanStepType;
  /** Emoji icon for the button */
  icon: string;
}

/** Available actions for entity command panel */
const ENTITY_ACTIONS: ActionDef[] = [
  { label: 'Perform on Stage', stepType: 'go_to_stage', icon: '🎤' },
  { label: 'Eat Food', stepType: 'go_to_kitchen', icon: '🍕' },
  { label: 'Take a Break', stepType: 'go_to_couch', icon: '🛋️' },
  { label: 'Play Poker', stepType: 'go_to_poker_table', icon: '🃏' },
  { label: 'Hang Out', stepType: 'go_to_break_room', icon: '☕' },
  { label: 'Wander', stepType: 'wander', icon: '🚶' },
  { label: 'Pickleball', stepType: 'go_to_pickleball', icon: '🏓' },
  { label: 'Golf', stepType: 'go_to_golf', icon: '⛳' },
  { label: 'Sit Outside', stepType: 'sit_outdoor', icon: '🪑' },
];

// ====== NAME RESOLUTION ======

/**
 * Resolves a display name for an entity ID.
 *
 * @param entityId - The entity ID to resolve
 * @param agents - Agent map from context
 * @returns Human-readable entity name
 */
function resolveEntityName(
  entityId: string,
  agents: Map<string, { name?: string; sessionName?: string }>
): string {
  // Check agents map
  const agent = agents.get(entityId);
  if (agent) {
    return agent.name || agent.sessionName || entityId;
  }

  // Known NPCs
  if (entityId === 'steve-jobs-npc') return 'Steve Jobs';
  if (entityId === 'sundar-pichai-npc') return 'Sundar Pichai';

  // Fake audience members
  const audienceMatch = entityId.match(/^fake-audience-(\d+)$/);
  if (audienceMatch) {
    return `Audience Member ${Number(audienceMatch[1]) + 1}`;
  }

  return entityId;
}

// ====== COMPONENT ======

/**
 * EntityActionPanel - Displays action buttons when an entity is selected in boss mode.
 *
 * Positioned at the bottom-center of the viewport. Shows the entity name
 * and 6 action buttons that override the entity's current plan.
 *
 * @returns JSX element or null if no entity is selected / boss mode is inactive
 */
export const EntityActionPanel: React.FC = () => {
  const {
    selectedEntityId,
    agents,
    bossModeState,
    sendEntityCommand,
    clearSelection,
  } = useFactory();

  // Only render when an entity is selected and boss mode is active
  if (!selectedEntityId || !bossModeState.isActive) return null;

  const entityName = resolveEntityName(selectedEntityId, agents);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 pointer-events-auto">
      <div className="bg-surface-dark/90 backdrop-blur-sm rounded-2xl border border-border-dark shadow-xl px-4 py-3">
        {/* Header with entity name and close button */}
        <div className="flex items-center justify-between mb-2 gap-4">
          <span className="text-white text-sm font-medium truncate max-w-[200px]">
            {entityName}
          </span>
          <IconButton
            icon={X}
            size="xs"
            onClick={clearSelection}
            title="Close"
            aria-label="Close"
          />
        </div>

        {/* Action buttons row */}
        <div className="flex gap-2">
          {ENTITY_ACTIONS.map((action) => (
            <button
              key={action.stepType}
              onClick={() =>
                sendEntityCommand(selectedEntityId, { stepType: action.stepType })
              }
              className="flex flex-col items-center gap-1 px-3 py-2 rounded-md bg-background-dark/80 hover:bg-border-dark border border-border-dark/50 hover:border-primary/50 transition-all text-text-primary-dark hover:text-white"
              title={action.label}
            >
              <span className="text-base leading-none">{action.icon}</span>
              <span className="text-[10px] whitespace-nowrap">{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default EntityActionPanel;
