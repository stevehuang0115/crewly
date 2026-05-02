/**
 * Tests for GuardrailsBlock.
 *
 * @module components/Onboarding/v2-5/blocks/GuardrailsBlock.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GuardrailsBlock } from './GuardrailsBlock';

describe('GuardrailsBlock', () => {
  it('renders empty state when guardrails is undefined', () => {
    render(<GuardrailsBlock />);
    expect(screen.getByTestId('blueprint-block-guardrails')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders empty state when guardrails is empty array', () => {
    render(<GuardrailsBlock guardrails={[]} />);
    expect(screen.getByTestId('blueprint-block-guardrails')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders each guardrail as a chip when populated', () => {
    render(
      <GuardrailsBlock
        guardrails={['no political topics', 'no medical advice']}
      />
    );
    expect(screen.getByTestId('guardrails-filled')).toBeInTheDocument();
    expect(screen.getByTestId('guardrail-chip-0')).toHaveTextContent(
      'no political topics'
    );
    expect(screen.getByTestId('guardrail-chip-1')).toHaveTextContent(
      'no medical advice'
    );
  });
});
