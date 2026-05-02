/**
 * Tests for BlueprintBlock — the shared sidebar block shell.
 *
 * @module components/Onboarding/v2-5/blocks/BlueprintBlock.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BlueprintBlock } from './BlueprintBlock';

describe('BlueprintBlock', () => {
  it('renders the title and empty hint when not populated', () => {
    render(
      <BlueprintBlock
        blockId="business-profile"
        title="Business Profile"
        isPopulated={false}
        emptyHint="We'll fill this in as you tell us about your business."
      />
    );
    expect(screen.getByTestId('blueprint-block-business-profile')).toBeInTheDocument();
    expect(screen.getByTestId('blueprint-block-business-profile-title')).toHaveTextContent(
      'Business Profile'
    );
    expect(
      screen.getByTestId('blueprint-block-business-profile-empty')
    ).toHaveTextContent(/We'll fill this in/);
    expect(
      screen.queryByTestId('blueprint-block-business-profile-body')
    ).not.toBeInTheDocument();
  });

  it('renders the filled body when populated', () => {
    render(
      <BlueprintBlock
        blockId="match-report"
        title="Match Report"
        isPopulated={true}
        emptyHint="Empty"
      >
        <span data-testid="filled-marker">filled</span>
      </BlueprintBlock>
    );
    expect(screen.getByTestId('blueprint-block-match-report-body')).toBeInTheDocument();
    expect(screen.getByTestId('filled-marker')).toBeInTheDocument();
    expect(
      screen.queryByTestId('blueprint-block-match-report-empty')
    ).not.toBeInTheDocument();
  });

  it('exposes data-state="empty" when not populated', () => {
    render(
      <BlueprintBlock
        blockId="brand"
        title="Brand"
        isPopulated={false}
        emptyHint="hint"
      />
    );
    expect(screen.getByTestId('blueprint-block-brand')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('exposes data-state="populated" + data-revealed="true" on first render when populated', () => {
    render(
      <BlueprintBlock
        blockId="brand"
        title="Brand"
        isPopulated={true}
        emptyHint="hint"
      >
        body
      </BlueprintBlock>
    );
    const block = screen.getByTestId('blueprint-block-brand');
    expect(block).toHaveAttribute('data-state', 'populated');
    // First-render-populated is synchronous to avoid a flash, so the
    // revealed flag is true on initial mount.
    expect(block).toHaveAttribute('data-revealed', 'true');
  });

  it('exposes data-revealed="false" the instant a populated→empty transition happens', () => {
    const { rerender } = render(
      <BlueprintBlock
        blockId="guardrails"
        title="Guardrails"
        isPopulated={true}
        emptyHint="hint"
      >
        body
      </BlueprintBlock>
    );
    rerender(
      <BlueprintBlock
        blockId="guardrails"
        title="Guardrails"
        isPopulated={false}
        emptyHint="hint"
      />
    );
    expect(screen.getByTestId('blueprint-block-guardrails')).toHaveAttribute(
      'data-state',
      'empty'
    );
    expect(screen.getByTestId('blueprint-block-guardrails')).toHaveAttribute(
      'data-revealed',
      'false'
    );
  });

  it('starts with data-revealed="false" then flips to "true" after rAF on empty→populated transition', async () => {
    const { rerender } = render(
      <BlueprintBlock
        blockId="staffed-workflows"
        title="Staffed Workflows"
        isPopulated={false}
        emptyHint="hint"
      />
    );
    rerender(
      <BlueprintBlock
        blockId="staffed-workflows"
        title="Staffed Workflows"
        isPopulated={true}
        emptyHint="hint"
      >
        body
      </BlueprintBlock>
    );
    const block = screen.getByTestId('blueprint-block-staffed-workflows');
    expect(block).toHaveAttribute('data-state', 'populated');
    // The reveal flag flips via requestAnimationFrame inside an
    // effect — wait for it to land. waitFor handles the React state
    // commit + act() wrapping.
    await waitFor(() =>
      expect(block).toHaveAttribute('data-revealed', 'true')
    );
  });
});
