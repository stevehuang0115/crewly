/**
 * VisibilityToggles - Bottom-left panel for toggling visibility of scene elements.
 *
 * Controls:
 * - NPC Agents: Fake audience members
 * - Guest Agents: Celebrity NPCs (Steve Jobs, Sundar, etc.)
 * - Objects: Additional scene objects (Cybertruck, etc.)
 */

import React, { useState } from 'react';
import { Eye, EyeOff, ChevronUp, ChevronDown, Users, UserCheck, Car } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { useFactory } from '../../../contexts/FactoryContext';

/**
 * Toggle switch configuration
 */
interface ToggleConfig {
  /** Unique key for the toggle */
  key: 'npc' | 'guest' | 'objects';
  /** Display label */
  label: string;
  /** Icon component */
  icon: React.ReactNode;
  /** Current visibility state */
  isVisible: boolean;
  /** Toggle handler */
  onToggle: (visible: boolean) => void;
}

/**
 * VisibilityToggles - Panel with toggles for showing/hiding scene elements.
 *
 * When collapsed, shows just the button. When expanded, shows all toggle options.
 *
 * @returns JSX element with visibility toggle controls
 */
export const VisibilityToggles: React.FC = () => {
  const {
    showNPCAgents,
    setShowNPCAgents,
    showGuestAgents,
    setShowGuestAgents,
    showObjects,
    setShowObjects,
  } = useFactory();

  const [isExpanded, setIsExpanded] = useState(false);

  // Toggle configurations
  const toggles: ToggleConfig[] = [
    {
      key: 'npc',
      label: 'NPC Agents',
      icon: <Users className="w-4 h-4" />,
      isVisible: showNPCAgents,
      onToggle: setShowNPCAgents,
    },
    {
      key: 'guest',
      label: 'Guest Agents',
      icon: <UserCheck className="w-4 h-4" />,
      isVisible: showGuestAgents,
      onToggle: setShowGuestAgents,
    },
    {
      key: 'objects',
      label: 'Objects',
      icon: <Car className="w-4 h-4" />,
      isVisible: showObjects,
      onToggle: setShowObjects,
    },
  ];

  // Count how many are hidden
  const hiddenCount = toggles.filter((t) => !t.isVisible).length;

  return (
    <div className="absolute bottom-6 left-4 z-10">
      {/* Expanded panel */}
      {isExpanded && (
        <div className="mb-2 bg-surface-dark/90 backdrop-blur-sm rounded-2xl border border-border-dark shadow-xl p-3 min-w-[180px]">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-border-dark">
            <span className="text-white text-sm font-medium">Visibility</span>
            <IconButton
              icon={ChevronDown}
              size="xs"
              onClick={() => setIsExpanded(false)}
              aria-label="Collapse panel"
            />
          </div>

          <div className="space-y-2">
            {toggles.map((toggle) => (
              <label
                key={toggle.key}
                className="flex items-center gap-3 cursor-pointer group"
              >
                {/* Toggle switch */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={toggle.isVisible}
                  onClick={() => toggle.onToggle(!toggle.isVisible)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    toggle.isVisible ? 'bg-primary' : 'bg-border-dark'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      toggle.isVisible ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>

                {/* Icon and label */}
                <span
                  className={`flex items-center gap-2 text-sm transition-colors ${
                    toggle.isVisible
                      ? 'text-white'
                      : 'text-text-secondary-dark group-hover:text-text-primary-dark'
                  }`}
                >
                  {toggle.icon}
                  {toggle.label}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border shadow-lg transition-all ${
          hiddenCount > 0
            ? 'bg-orange-900/90 border-orange-500/50 text-orange-200'
            : 'bg-background-dark/90 border-border-dark/50 text-text-primary-dark'
        }`}
        title="Toggle element visibility"
      >
        {hiddenCount > 0 ? (
          <EyeOff className="w-4 h-4" />
        ) : (
          <Eye className="w-4 h-4" />
        )}
        <span className="text-xs font-medium">
          {hiddenCount > 0 ? `${hiddenCount} Hidden` : 'Visibility'}
        </span>
        {isExpanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronUp className="w-3 h-3" />
        )}
      </button>
    </div>
  );
};

export default VisibilityToggles;
