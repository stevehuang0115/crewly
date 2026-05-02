/**
 * StaffedWorkflowsBlock — sidebar block for the user's opted-in
 * workflow staffing list (S5).
 *
 * **W1**: empty-state shell + types only — full implementation lands
 * W3 once B7 surfaces the Match Report and S5 staffing flow lands.
 * The W1 populated variant renders a minimal list so stories can
 * exercise the populated path.
 *
 * Spec ref: §4.4 Delegation, §6 Brand & ops.
 *
 * @module components/Onboarding/v2-5/blocks/StaffedWorkflowsBlock
 */

import type { ReactNode } from 'react';
import type { HirableWorkflow } from '../../../../types/onboarding-blueprint.types';
import { BlueprintBlock } from './BlueprintBlock';

export interface StaffedWorkflowsBlockProps {
  /** Workflows the user opted into. Empty array or undefined = empty state. */
  workflows?: HirableWorkflow[];
}

/**
 * Render the Staffed Workflows sidebar block.
 *
 * @param workflows - Opt-in workflow list. Empty/undefined renders
 *   the empty-state placeholder.
 *
 * @example
 * ```tsx
 * <StaffedWorkflowsBlock workflows={blueprint.staffedWorkflows} />
 * ```
 */
export function StaffedWorkflowsBlock({
  workflows,
}: StaffedWorkflowsBlockProps): ReactNode {
  const isPopulated = workflows != null && workflows.length > 0;
  return (
    <BlueprintBlock
      blockId="staffed-workflows"
      title="Staffed Workflows"
      isPopulated={isPopulated}
      emptyHint="We'll list the workflows you're hiring once you've picked them."
    >
      {isPopulated ? (
        <ul
          data-testid="staffed-workflows-filled"
          className="ml-1 list-disc space-y-1 pl-4 text-sm"
        >
          {workflows!.map((w) => (
            <li
              key={w.workflowId}
              data-testid={`staffed-workflow-${w.workflowId}`}
            >
              <span className="font-medium text-gray-900">{w.name}</span>
              {w.estimatedValue ? (
                <span className="ml-1 text-xs text-gray-500">
                  ({w.estimatedValue})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </BlueprintBlock>
  );
}

export default StaffedWorkflowsBlock;
