/**
 * HarnessList
 *
 * All coding harnesses with their status cards, plus a note for any
 * missing system tool (e.g. `jq`). Used by the setup flow (selectable)
 * and by Settings → Harness (read-only selection).
 *
 * @module components/Harness/HarnessList
 */

import React from 'react';
import { Alert } from '@crewly/ui';
import type { HarnessId, HarnessStatus, SystemToolStatus } from '../../types/harness.types';
import { HarnessCard } from './HarnessCard';

export interface HarnessListProps {
  /** Harnesses in display order */
  harnesses: HarnessStatus[];
  /** Supporting system tools */
  systemTools?: SystemToolStatus[];
  /** Selected harness (enables radio selection when `onSelect` is set) */
  selectedId?: HarnessId | null;
  /** Selection handler */
  onSelect?: (id: HarnessId) => void;
  /** Called after any install job ends */
  onInstallFinished?: () => void;
}

/** Radio group name for harness selection. */
const SELECT_NAME = 'harness-choice';

/**
 * List of harness cards.
 *
 * @param props - {@link HarnessListProps}
 * @returns List element
 */
export const HarnessList: React.FC<HarnessListProps> = ({
  harnesses,
  systemTools = [],
  selectedId,
  onSelect,
  onInstallFinished,
}) => {
  const missingTools = systemTools.filter((t) => !t.installed);

  return (
    <div className="space-y-3" data-testid="harness-list">
      <div role={onSelect ? 'radiogroup' : undefined} aria-label={onSelect ? '选择编程助手' : undefined} className="space-y-3">
        {harnesses.map((h) => (
          <HarnessCard
            key={h.id}
            harness={h}
            selectName={onSelect ? SELECT_NAME : undefined}
            selected={onSelect ? selectedId === h.id : false}
            onSelect={onSelect}
            onInstallFinished={() => onInstallFinished?.()}
          />
        ))}
      </div>
      {missingTools.map((tool) => (
        <Alert key={tool.id} variant="warning" size="sm" title={`缺少系统工具 ${tool.id} / Missing ${tool.id}`}>
          <span>部分技能需要它。安装方法：</span>
          <code className="ml-1 rounded bg-background-dark px-1.5 py-0.5 font-mono text-xs">{tool.installHint}</code>
        </Alert>
      ))}
    </div>
  );
};
