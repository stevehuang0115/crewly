/**
 * GuardrailsBlock — sidebar block for captured user guardrails.
 *
 * **W1**: empty-state shell + simple list. Full implementation
 * (chip-style with edit affordances) lands W3+.
 *
 * Spec ref: §4.2 Discovery dimensions (D6), §6 Brand & ops.
 *
 * @module components/Onboarding/v2-5/blocks/GuardrailsBlock
 */

import type { ReactNode } from 'react';
import { BlueprintBlock } from './BlueprintBlock';

export interface GuardrailsBlockProps {
  /** Captured guardrails. Empty array or undefined renders empty state. */
  guardrails?: string[];
}

/**
 * Render the Guardrails sidebar block.
 *
 * @param guardrails - User-supplied guardrails. Empty/undefined =
 *   empty-state placeholder.
 *
 * @example
 * ```tsx
 * <GuardrailsBlock guardrails={blueprint.guardrails} />
 * ```
 */
export function GuardrailsBlock({
  guardrails,
}: GuardrailsBlockProps): ReactNode {
  const isPopulated = guardrails != null && guardrails.length > 0;
  return (
    <BlueprintBlock
      blockId="guardrails"
      title="Guardrails"
      isPopulated={isPopulated}
      emptyHint="We'll capture your guardrails — what your AI must / must not do."
    >
      {isPopulated ? (
        <ul
          data-testid="guardrails-filled"
          className="flex flex-wrap gap-1.5 text-xs"
        >
          {guardrails!.map((g, i) => (
            <li
              key={`${g}-${i}`}
              data-testid={`guardrail-chip-${i}`}
              className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700"
            >
              {g}
            </li>
          ))}
        </ul>
      ) : null}
    </BlueprintBlock>
  );
}

export default GuardrailsBlock;
