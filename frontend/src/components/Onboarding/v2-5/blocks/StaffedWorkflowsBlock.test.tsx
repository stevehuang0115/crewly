/**
 * Tests for StaffedWorkflowsBlock.
 *
 * @module components/Onboarding/v2-5/blocks/StaffedWorkflowsBlock.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StaffedWorkflowsBlock } from './StaffedWorkflowsBlock';

describe('StaffedWorkflowsBlock', () => {
  it('renders empty state when workflows is undefined', () => {
    render(<StaffedWorkflowsBlock />);
    expect(screen.getByTestId('blueprint-block-staffed-workflows')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders empty state when workflows is empty array', () => {
    render(<StaffedWorkflowsBlock workflows={[]} />);
    expect(screen.getByTestId('blueprint-block-staffed-workflows')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders each workflow when populated', () => {
    render(
      <StaffedWorkflowsBlock
        workflows={[
          {
            workflowId: 'wf-1',
            name: 'Newsletter Drafter',
            description: 'Drafts your weekly newsletter.',
            estimatedValue: '4 hrs/wk',
          },
          {
            workflowId: 'wf-2',
            name: 'Inbox Triage',
            description: 'Triages support email.',
          },
        ]}
      />
    );
    expect(screen.getByTestId('staffed-workflow-wf-1')).toHaveTextContent(
      'Newsletter Drafter'
    );
    expect(screen.getByTestId('staffed-workflow-wf-1')).toHaveTextContent('4 hrs/wk');
    expect(screen.getByTestId('staffed-workflow-wf-2')).toHaveTextContent(
      'Inbox Triage'
    );
    expect(screen.getByTestId('staffed-workflow-wf-2').textContent ?? '').not.toMatch(
      /\(/
    );
  });
});
