/**
 * LightingToggle - Day/Night/Auto mode toggle button.
 *
 * Controls the lighting mode of the factory visualization.
 */

import React from 'react';
import { Sun, Moon, Clock } from 'lucide-react';
import { useFactory } from '../../../contexts/FactoryContext';
import { LightingMode } from '../../../types/factory.types';

/**
 * LightingToggle - Cycles through lighting modes.
 *
 * Modes:
 * - Day: Always bright
 * - Night: Always dark with spotlights
 * - Auto: Based on local time
 *
 * @returns JSX element with toggle button
 */
export const LightingToggle: React.FC = () => {
  const { lightingMode, setLightingMode, isNightMode } = useFactory();

  /**
   * Cycle to next lighting mode.
   */
  const handleToggle = () => {
    const modes: LightingMode[] = ['day', 'night', 'auto'];
    const currentIndex = modes.indexOf(lightingMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    setLightingMode(modes[nextIndex]);
  };

  /**
   * Get icon for current mode.
   */
  const getIcon = () => {
    switch (lightingMode) {
      case 'day':
        return <Sun className="w-4 h-4" />;
      case 'night':
        return <Moon className="w-4 h-4" />;
      case 'auto':
        return <Clock className="w-4 h-4" />;
    }
  };

  /**
   * Get label for current mode.
   */
  const getLabel = () => {
    switch (lightingMode) {
      case 'day':
        return 'Day';
      case 'night':
        return 'Night';
      case 'auto':
        return isNightMode ? 'Auto (Night)' : 'Auto (Day)';
    }
  };

  return (
    <button
      onClick={handleToggle}
      className={`absolute top-4 right-[200px] flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border shadow-lg transition-all z-10 ${
        lightingMode === 'night' || (lightingMode === 'auto' && isNightMode)
          ? 'bg-surface-dark border-primary/50 text-primary'
          : 'bg-amber-100/95 border-amber-400/50 text-amber-900'
      }`}
      title="Toggle lighting mode (Day/Night/Auto)"
    >
      {getIcon()}
      <span className="text-xs font-medium">{getLabel()}</span>
    </button>
  );
};

export default LightingToggle;
