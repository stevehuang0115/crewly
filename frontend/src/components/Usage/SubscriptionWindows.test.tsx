/**
 * Tests for SubscriptionWindows.
 *
 * @module components/Usage/SubscriptionWindows.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SubscriptionWindows, limitSentence, untilLabel, windowMeta } from './SubscriptionWindows';
import type { ClaudeWindowReport, ClaudeWindowUsage } from '../../services/usage.service';

const NOW = new Date('2026-10-12T10:00:00.000Z');

/** A measured window. */
function window(over: Partial<ClaudeWindowUsage> = {}): ClaudeWindowUsage {
  return {
    id: 'five_hour',
    label: '5-hour window',
    startedAt: '2026-10-12T05:00:00.000Z',
    partial: false,
    turns: 73,
    input: 146,
    cachedInput: 39_865_920,
    cacheWrite: 733_409,
    output: 48_206,
    billable: 781_761,
    ...over,
  };
}

/** A report. */
function report(over: Partial<ClaudeWindowReport> = {}): ClaudeWindowReport {
  return {
    measuredAt: NOW.toISOString(),
    windows: [window()],
    lastLimit: null,
    filesScanned: 15,
    truncated: false,
    estimatedFiveHourCapacity: null,
    ...over,
  };
}

describe('untilLabel', () => {
  it('counts hours and minutes ahead', () => {
    expect(untilLabel('2026-10-12T11:30:00.000Z', NOW)).toBe('in 1h 30m');
    expect(untilLabel('2026-10-12T10:20:00.000Z', NOW)).toBe('in 20m');
  });

  it('says "now" for a moment already past', () => {
    expect(untilLabel('2026-10-12T09:00:00.000Z', NOW)).toBe('now');
    expect(untilLabel('not a date', NOW)).toBe('now');
  });
});

describe('windowMeta', () => {
  it('names the token split and marks cache reads as excluded', () => {
    expect(windowMeta(window())).toBe('73 turns · 146 input · 48.2K output · 733K cache writes · 39.9M cache reads (not counted)');
  });

  it('keeps the singular for one turn', () => {
    expect(windowMeta(window({ turns: 1 }))).toContain('1 turn ·');
  });
});

describe('limitSentence', () => {
  it('is null when the plan has never been refused here', () => {
    expect(limitSentence(null, NOW)).toBeNull();
  });

  it('names the window, the utilisation and the reset', () => {
    const sentence = limitSentence(
      {
        at: '2026-10-11T23:05:35.833Z',
        rateLimitType: 'five_hour',
        resetsAt: '2026-10-12T11:00:00.000Z',
        utilization: { '5h': 0.99 },
        overageStatus: 'rejected',
      },
      NOW,
    );
    expect(sentence).toContain('on the five-hour limit');
    expect(sentence).toContain('at 99% of the window');
    expect(sentence).toContain('reset in 1h 0m');
  });

  it('does not promise a reset that already happened', () => {
    const sentence = limitSentence(
      { at: '2026-10-11T23:05:35.833Z', rateLimitType: 'five_hour', resetsAt: '2026-10-12T02:40:00.000Z', utilization: {}, overageStatus: null },
      NOW,
    );
    expect(sentence).not.toContain('reset');
  });

  it('leaves out a utilisation Anthropic did not send', () => {
    const sentence = limitSentence(
      { at: '2026-10-11T23:05:35.833Z', rateLimitType: 'five_hour', resetsAt: null, utilization: {}, overageStatus: null },
      NOW,
    );
    expect(sentence).not.toContain('% of the window');
    expect(sentence).not.toContain('reset');
  });
});

describe('SubscriptionWindows', () => {
  it('renders nothing while the report is loading', () => {
    const { container } = render(<SubscriptionWindows report={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the billable tokens of each window, not a made-up percentage', () => {
    render(<SubscriptionWindows report={report({ windows: [window(), window({ id: 'seven_day', label: '7-day window', billable: 14_058_958 })] })} now={() => NOW} />);

    expect(screen.getByRole('heading', { name: 'Subscription windows' })).toBeInTheDocument();
    expect(screen.getByText('782K')).toBeInTheDocument();
    expect(screen.getByText('14.1M')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('marks a window the reader could not cover in full', () => {
    render(<SubscriptionWindows report={report({ windows: [window({ partial: true })] })} now={() => NOW} />);
    expect(screen.getByText(/At least this much/)).toBeInTheDocument();
  });

  it('reports the last refusal and the capacity it implies', () => {
    render(
      <SubscriptionWindows
        report={report({
          lastLimit: {
            at: '2026-10-11T23:05:35.833Z',
            rateLimitType: 'five_hour',
            resetsAt: '2026-10-12T11:00:00.000Z',
            utilization: { '5h': 0.99 },
            overageStatus: 'rejected',
          },
          estimatedFiveHourCapacity: 790_000,
        })}
        now={() => NOW}
      />,
    );
    expect(screen.getByText(/Last refused/)).toHaveTextContent('roughly 790K tokens');
  });
});
