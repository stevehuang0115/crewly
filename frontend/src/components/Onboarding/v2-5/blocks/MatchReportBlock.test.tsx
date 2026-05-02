/**
 * Tests for MatchReportBlock.
 *
 * @module components/Onboarding/v2-5/blocks/MatchReportBlock.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MatchReportBlock } from './MatchReportBlock';
import type { MatchReport } from '../../../../types/onboarding-blueprint.types';

const EMPTY_REPORT: MatchReport = {
  autonomous: [],
  collaborative: [],
  roadmap: [],
  outOfScope: [],
};

describe('MatchReportBlock', () => {
  it('renders empty state when report is undefined', () => {
    render(<MatchReportBlock />);
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders empty state when all tiers are empty arrays', () => {
    render(<MatchReportBlock report={EMPTY_REPORT} />);
    expect(screen.getByTestId('blueprint-block-match-report')).toHaveAttribute(
      'data-state',
      'empty'
    );
  });

  it('renders only the autonomous tier when only it has items', () => {
    render(
      <MatchReportBlock
        report={{
          ...EMPTY_REPORT,
          autonomous: [
            {
              workflowId: 'wf-newsletter',
              name: 'Draft Newsletter',
              description: 'desc',
            },
          ],
        }}
      />
    );
    expect(screen.getByTestId('match-report-autonomous')).toBeInTheDocument();
    expect(screen.queryByTestId('match-report-collaborative')).not.toBeInTheDocument();
    expect(screen.queryByTestId('match-report-roadmap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('match-report-out-of-scope')).not.toBeInTheDocument();
  });

  it('renders all four tiers when populated', () => {
    render(
      <MatchReportBlock
        report={{
          autonomous: [
            { workflowId: 'wf-1', name: 'Newsletter Draft', description: '' },
          ],
          collaborative: [
            { workflowId: 'wf-2', name: 'Email Reply Triage', description: '' },
          ],
          roadmap: [{ workflow: 'Cold-call dialer', eta: 'Q3 2026' }],
          outOfScope: [
            { task: 'Manual phone calls', workaround: 'use a VA' },
          ],
        }}
      />
    );
    expect(screen.getByTestId('match-report-autonomous-wf-1')).toHaveTextContent(
      'Newsletter Draft'
    );
    expect(
      screen.getByTestId('match-report-collaborative-wf-2')
    ).toHaveTextContent('Email Reply Triage');
    expect(screen.getByTestId('match-report-roadmap-0')).toHaveTextContent(
      'Cold-call dialer'
    );
    expect(screen.getByTestId('match-report-roadmap-0')).toHaveTextContent(
      'Q3 2026'
    );
    expect(screen.getByTestId('match-report-out-of-scope-0')).toHaveTextContent(
      'Manual phone calls'
    );
    expect(screen.getByTestId('match-report-out-of-scope-0')).toHaveTextContent(
      'workaround: use a VA'
    );
  });

  it('omits eta + workaround when not provided', () => {
    render(
      <MatchReportBlock
        report={{
          ...EMPTY_REPORT,
          roadmap: [{ workflow: 'Future Workflow' }],
          outOfScope: [{ task: 'Something we cannot do' }],
        }}
      />
    );
    const roadmapItem = screen.getByTestId('match-report-roadmap-0');
    expect(roadmapItem).toHaveTextContent('Future Workflow');
    expect(roadmapItem.textContent ?? '').not.toMatch(/·/);

    const oosItem = screen.getByTestId('match-report-out-of-scope-0');
    expect(oosItem).toHaveTextContent('Something we cannot do');
    expect(oosItem.textContent ?? '').not.toMatch(/workaround/);
  });
});
