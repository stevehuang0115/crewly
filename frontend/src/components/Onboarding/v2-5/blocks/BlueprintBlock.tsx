/**
 * BlueprintBlock — shared wrapper for the five sidebar sections.
 *
 * Owns the visual chrome (title, empty-state placeholder, Progressive
 * Reveal animation) so each block component focuses on its filled
 * variant only. Reduces duplication and keeps the empty-state copy
 * pattern consistent.
 *
 * Progressive Reveal: when a block transitions from empty → populated,
 * a CSS transition fades opacity 0 → 1 with a small translateY. We
 * track the transition by adding a `data-state="populated"` attribute
 * one tick after `isPopulated` flips, and the matching CSS rule keys
 * off that attribute. When `isPopulated` is true on first render
 * (story / refresh case) we skip the animation by writing `populated`
 * synchronously — no flash.
 *
 * Spec ref: §3 Live Blueprint / §F8 Progressive Reveal.
 *
 * @module components/Onboarding/v2-5/blocks/BlueprintBlock
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BlueprintBlockId } from '../../../../types/onboarding-blueprint.types';

export interface BlueprintBlockProps {
  /** Stable block identifier — drives test IDs + ordering. */
  blockId: BlueprintBlockId;
  /** Section title shown at the top of the block. */
  title: string;
  /** Whether the block has data to show. */
  isPopulated: boolean;
  /** Copy shown when `isPopulated` is false. */
  emptyHint: string;
  /** Filled-state body. Ignored when `isPopulated` is false. */
  children?: ReactNode;
}

/**
 * Render a sidebar block with empty-state and Progressive Reveal.
 *
 * @param blockId - One of the five spec block IDs.
 * @param title - Section heading.
 * @param isPopulated - Drives empty vs filled rendering.
 * @param emptyHint - Empty-state copy.
 * @param children - Filled-state body (rendered when populated).
 *
 * @example
 * ```tsx
 * <BlueprintBlock
 *   blockId="match-report"
 *   title="Match Report"
 *   isPopulated={Boolean(matchReport)}
 *   emptyHint="We'll show your 4-tier Match Report once we have your tasks."
 * >
 *   {matchReport ? <MatchReportFilled report={matchReport} /> : null}
 * </BlueprintBlock>
 * ```
 */
export function BlueprintBlock({
  blockId,
  title,
  isPopulated,
  emptyHint,
  children,
}: BlueprintBlockProps): ReactNode {
  // Progressive Reveal: synchronous when first render is populated
  // (no flash on refresh), animated when empty→populated transition
  // happens during the session.
  const [revealed, setRevealed] = useState(isPopulated);
  const previousPopulated = useRef(isPopulated);
  useEffect(() => {
    if (isPopulated && !previousPopulated.current) {
      // Defer one frame so the CSS transition has an "off" state to
      // animate from.
      const id = requestAnimationFrame(() => setRevealed(true));
      previousPopulated.current = true;
      return () => cancelAnimationFrame(id);
    }
    if (!isPopulated && previousPopulated.current) {
      // Empty out — collapse instantly. Spec doesn't call for an
      // exit animation.
      setRevealed(false);
      previousPopulated.current = false;
    }
    return undefined;
  }, [isPopulated]);

  return (
    <section
      data-testid={`blueprint-block-${blockId}`}
      data-block-id={blockId}
      data-state={isPopulated ? 'populated' : 'empty'}
      data-revealed={revealed ? 'true' : 'false'}
      className="blueprint-block rounded-lg border border-gray-200 bg-white p-4"
    >
      <header className="mb-2">
        <h3
          className="text-sm font-semibold text-gray-900"
          data-testid={`blueprint-block-${blockId}-title`}
        >
          {title}
        </h3>
      </header>
      {isPopulated ? (
        <div
          data-testid={`blueprint-block-${blockId}-body`}
          className="blueprint-block-body"
        >
          {children}
        </div>
      ) : (
        <p
          data-testid={`blueprint-block-${blockId}-empty`}
          className="text-sm text-gray-500"
        >
          {emptyHint}
        </p>
      )}
    </section>
  );
}

export default BlueprintBlock;
