/**
 * BrandBlock — sidebar block for brand voice + tone + ops channel.
 *
 * **W1**: empty-state shell + simple chip rendering. Full
 * implementation (with the F5 chip picker / F6 tone single-select)
 * lands W4.
 *
 * Spec ref: §6 Brand & ops, §12.2 rows F5/F6.
 *
 * @module components/Onboarding/v2-5/blocks/BrandBlock
 */

import type { ReactNode } from 'react';
import type { OnboardingBrand } from '../../../../types/onboarding-blueprint.types';
import { BlueprintBlock } from './BlueprintBlock';

export interface BrandBlockProps {
  /** Brand snapshot. Undefined renders the empty state. */
  brand?: OnboardingBrand;
}

/**
 * Render the Brand sidebar block.
 *
 * @param brand - Captured brand voice + tone + approval channel.
 *   Undefined renders the empty-state placeholder.
 *
 * @example
 * ```tsx
 * <BrandBlock brand={blueprint.brand} />
 * ```
 */
export function BrandBlock({ brand }: BrandBlockProps): ReactNode {
  const isPopulated = brand != null && hasAnyBrandField(brand);
  return (
    <BlueprintBlock
      blockId="brand"
      title="Brand & Ops"
      isPopulated={isPopulated}
      emptyHint="We'll capture your brand voice and approval channel later in the chat."
    >
      {isPopulated ? <FilledBody brand={brand!} /> : null}
    </BlueprintBlock>
  );
}

function hasAnyBrandField(b: OnboardingBrand): boolean {
  return b.voiceChips.length > 0 || Boolean(b.tone) || Boolean(b.approvalChannel);
}

interface FilledBodyProps {
  brand: OnboardingBrand;
}

function FilledBody({ brand }: FilledBodyProps): ReactNode {
  return (
    <div data-testid="brand-filled" className="space-y-2 text-sm">
      {brand.voiceChips.length > 0 ? (
        <div data-testid="brand-voice-chips">
          <div className="text-xs uppercase tracking-wide text-gray-500">Voice</div>
          <ul className="mt-1 flex flex-wrap gap-1.5 text-xs">
            {brand.voiceChips.map((chip, i) => (
              <li
                key={`${chip}-${i}`}
                data-testid={`brand-voice-chip-${i}`}
                className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700"
              >
                {chip}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {brand.tone ? (
        <div data-testid="brand-tone">
          <span className="text-xs uppercase tracking-wide text-gray-500">Tone:</span>{' '}
          <span className="text-gray-900">{brand.tone}</span>
        </div>
      ) : null}
      {brand.approvalChannel ? (
        <div data-testid="brand-approval-channel">
          <span className="text-xs uppercase tracking-wide text-gray-500">
            Approval:
          </span>{' '}
          <span className="text-gray-900">{brand.approvalChannel}</span>
        </div>
      ) : null}
    </div>
  );
}

export default BrandBlock;
