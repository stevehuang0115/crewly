/**
 * Security Pillar Card — Reusable card for each security pillar
 *
 * Displays an icon, title, description, and "See how" link for one of the
 * three Crewly security pillars (PTY Isolation, Local Vector Storage,
 * Granular Tool Approval). Per spec section 2.1.
 *
 * @module components/Security/SecurityPillarCard
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';

/** Pillar identifier for the three security pillars */
export type PillarId = 'pty' | 'storage' | 'approval';

/** Props for SecurityPillarCard */
export interface SecurityPillarCardProps {
  /** Unique pillar identifier */
  id: PillarId;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Card title */
  title: string;
  /** Card description */
  description: string;
  /** Whether this pillar is currently active/selected */
  isActive: boolean;
  /** Callback when the "See how" link is clicked */
  onSeeHow: (id: PillarId) => void;
}

/** Border color per pillar — matches spec section 5 PTY Border Colors */
const PILLAR_COLORS: Record<PillarId, { border: string; iconBg: string; activeBorder: string }> = {
  pty: {
    border: 'border-zinc-700',
    iconBg: 'bg-blue-500/10 text-blue-400',
    activeBorder: 'border-blue-500 ring-1 ring-blue-500/30',
  },
  storage: {
    border: 'border-zinc-700',
    iconBg: 'bg-purple-500/10 text-purple-400',
    activeBorder: 'border-purple-500 ring-1 ring-purple-500/30',
  },
  approval: {
    border: 'border-zinc-700',
    iconBg: 'bg-pink-500/10 text-pink-400',
    activeBorder: 'border-pink-500 ring-1 ring-pink-500/30',
  },
};

/**
 * Renders a single security pillar card with icon, title, description,
 * and a "See how" call-to-action link.
 *
 * @param props - SecurityPillarCardProps
 * @returns Pillar card element
 */
export const SecurityPillarCard: React.FC<SecurityPillarCardProps> = ({
  id,
  icon: Icon,
  title,
  description,
  isActive,
  onSeeHow,
}) => {
  const colors = PILLAR_COLORS[id];
  const borderClass = isActive ? colors.activeBorder : colors.border;

  const handleClick = () => {
    onSeeHow(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSeeHow(id);
    }
  };

  return (
    <div
      className={`rounded-lg border p-6 bg-zinc-900 transition-all duration-200 ${borderClass}`}
      data-testid={`pillar-card-${id}`}
    >
      {/* Icon */}
      <div className={`inline-flex items-center justify-center w-10 h-10 rounded-lg mb-4 ${colors.iconBg}`}>
        <Icon size={20} aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="text-lg font-semibold text-zinc-100 mb-2">{title}</h3>

      {/* Description */}
      <p className="text-sm text-zinc-400 mb-4 leading-relaxed">{description}</p>

      {/* See how link */}
      <button
        type="button"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className="text-sm font-medium text-emerald-400 hover:text-emerald-300 transition-colors inline-flex items-center gap-1"
        aria-expanded={isActive}
        aria-controls="security-arch-diagram"
      >
        See how
        <span aria-hidden="true">&rarr;</span>
      </button>
    </div>
  );
};

SecurityPillarCard.displayName = 'SecurityPillarCard';
