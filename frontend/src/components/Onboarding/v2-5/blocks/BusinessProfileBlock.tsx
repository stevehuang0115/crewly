/**
 * BusinessProfileBlock — sidebar block for the D1–D6 captured
 * discovery answers.
 *
 * Empty: prompts the user that the orc will fill it in. Populated:
 * lists the captured fields with labels.
 *
 * Spec ref: §4.2 Discovery dimensions, §3 Live Blueprint UX.
 *
 * @module components/Onboarding/v2-5/blocks/BusinessProfileBlock
 */

import type { ReactNode } from 'react';
import type { BusinessProfile } from '../../../../types/onboarding-blueprint.types';
import { BlueprintBlock } from './BlueprintBlock';

export interface BusinessProfileBlockProps {
  /** Captured discovery answers, or `undefined` for empty state. */
  profile?: BusinessProfile;
}

/**
 * Render the Business Profile sidebar block.
 *
 * @param profile - Captured discovery fields. When `undefined`,
 *   renders the empty-state placeholder.
 *
 * @example
 * ```tsx
 * <BusinessProfileBlock profile={blueprint.businessProfile} />
 * ```
 */
export function BusinessProfileBlock({
  profile,
}: BusinessProfileBlockProps): ReactNode {
  const isPopulated = profile != null && hasAnyField(profile);

  return (
    <BlueprintBlock
      blockId="business-profile"
      title="Business Profile"
      isPopulated={isPopulated}
      emptyHint="We'll fill this in as you tell us about your business."
    >
      {isPopulated ? <FilledBody profile={profile!} /> : null}
    </BlueprintBlock>
  );
}

/**
 * Returns true when the profile has at least one populated field.
 */
function hasAnyField(p: BusinessProfile): boolean {
  return Boolean(
    p.industry || p.customer || p.workflow || p.pain || p.priorTools || p.guardrails
  );
}

/** Field label config, kept inline (small + tied to this block). */
const FIELDS: { key: keyof BusinessProfile; label: string }[] = [
  { key: 'industry', label: 'Industry' },
  { key: 'customer', label: 'Customer' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'pain', label: 'Pain Point' },
  { key: 'priorTools', label: 'Prior Tools' },
  { key: 'guardrails', label: 'Guardrails' },
];

interface FilledBodyProps {
  profile: BusinessProfile;
}

/** Populated variant — only renders fields that have values. */
function FilledBody({ profile }: FilledBodyProps): ReactNode {
  return (
    <dl
      data-testid="business-profile-filled"
      className="grid grid-cols-1 gap-y-2 text-sm"
    >
      {FIELDS.filter(({ key }) => Boolean(profile[key])).map(({ key, label }) => (
        <div key={key} className="flex flex-col">
          <dt className="text-xs uppercase tracking-wide text-gray-500">
            {label}
          </dt>
          <dd
            className="text-gray-900"
            data-testid={`business-profile-${key}`}
          >
            {profile[key]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default BusinessProfileBlock;
