/**
 * OrcHarnessPicker
 *
 * Radio list of the installed harnesses; the chosen one runs the
 * orchestrator (orc). Controlled: the parent decides whether a change is
 * saved immediately (Settings) or on "下一步" (setup).
 *
 * @module components/Harness/OrcHarnessPicker
 */

import React from 'react';
import { Badge, EmptyState } from '@crewly/ui';
import { Bot } from 'lucide-react';
import type { HarnessId, HarnessStatus } from '../../types/harness.types';
import { DEFAULT_ORC_HARNESS, LOGIN_STATE_BADGES, harnessDisplayName } from '../../constants/harness.constants';

export interface OrcHarnessPickerProps {
  /** All harnesses (only installed ones are offered) */
  harnesses: HarnessStatus[];
  /** Selected harness */
  value: HarnessId | null;
  /** Selection handler */
  onChange: (id: HarnessId) => void;
  /** Disable while saving */
  disabled?: boolean;
}

/**
 * Pick the default orc harness: the current choice if still installed,
 * else Claude Code if installed, else the first installed one.
 *
 * @param harnesses - All harnesses
 * @param current - Current orc harness
 * @param preferred - Harness to prefer before the default
 * @returns Harness id, or null when none is installed
 */
export function defaultOrcChoice(
  harnesses: HarnessStatus[],
  current: HarnessId | null,
  preferred?: HarnessId | null,
): HarnessId | null {
  const installed = harnesses.filter((h) => h.installed && (!h.retired || h.id === current));
  for (const candidate of [current, preferred, DEFAULT_ORC_HARNESS]) {
    if (candidate && installed.some((h) => h.id === candidate)) return candidate;
  }
  return installed[0]?.id ?? null;
}

/**
 * Orc harness radio list.
 *
 * @param props - {@link OrcHarnessPickerProps}
 * @returns Radio group
 */
export const OrcHarnessPicker: React.FC<OrcHarnessPickerProps> = ({ harnesses, value, onChange, disabled = false }) => {
  // A retired harness (Gemini CLI) is offered only when it is the current choice.
  const installed = harnesses.filter((h) => h.installed && (!h.retired || h.id === value));

  if (installed.length === 0) {
    return (
      <EmptyState
        compact
        icon={Bot}
        title="还没有安装任何编程助手"
        description="先安装 Claude Code、Codex 或 Antigravity CLI，再回来选择。Install a harness first."
      />
    );
  }

  return (
    <div role="radiogroup" aria-label="Orc 使用的编程助手" className="space-y-2" data-testid="orc-harness-picker">
      {installed.map((h) => {
        const checked = value === h.id;
        const badge = LOGIN_STATE_BADGES[h.loginState];
        return (
          <label
            key={h.id}
            className={`flex items-center justify-between gap-3 rounded-2xl border p-3 cursor-pointer transition-colors ${
              checked ? 'border-primary bg-primary/10' : 'border-border-dark bg-surface-dark hover:border-primary/50'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <span className="flex items-center gap-3 min-w-0">
              <input
                type="radio"
                name="orc-harness"
                value={h.id}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(h.id)}
                className="h-4 w-4 accent-[var(--crewly-primary)]"
              />
              <span className="font-medium text-text-primary-dark truncate">{harnessDisplayName(h)}</span>
              {h.id === DEFAULT_ORC_HARNESS && <span className="text-xs text-text-secondary-dark">推荐</span>}
            </span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </label>
        );
      })}
    </div>
  );
};
