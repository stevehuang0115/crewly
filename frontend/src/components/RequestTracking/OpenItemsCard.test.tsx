// @vitest-environment jsdom
/**
 * Tests for OpenItemsCard and the open-item count on the request list
 * (specs/2026-10-01-reply-open-items.md).
 *
 * @module components/RequestTracking/OpenItemsCard.test
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpenItemsCard, type OpenItem } from './OpenItemsCard';
import { countActiveOpenItems } from './RequestList';

const items: OpenItem[] = [
  { id: 'c-1', type: 'commitment', text: '明天中午给我，我核过以后挑最有用的几条发你。', agent: 'Atlas', status: 'ready', createdAt: '2026-10-01T22:00:29Z', due: '2026-10-02T16:00:00Z', readyAt: '2026-10-01T22:17:10Z' },
  { id: 'q-1', type: 'question', text: '第 13 章「互评当体检用」这个读法，你同意吗？', agent: 'Atlas', status: 'resolved', createdAt: '2026-10-01T22:00:29Z', decisionId: 'D-3', answer: 'Yes' },
];

describe('OpenItemsCard', () => {
  it('lists promises and questions with their state, open ones counted', () => {
    render(<OpenItemsCard items={items} />);
    expect(screen.getByText(/Open items \(1 open\)/)).toBeTruthy();
    expect(screen.getByText('Promise')).toBeTruthy();
    expect(screen.getByText('Question')).toBeTruthy();
    expect(screen.getByText('Ready to deliver')).toBeTruthy();
    expect(screen.getByText('Answered')).toBeTruthy();
    expect(screen.getByText('Answer: Yes')).toBeTruthy();
    expect(screen.getAllByTestId('request-open-item')).toHaveLength(2);
  });
});

describe('countActiveOpenItems', () => {
  it('counts open / ready / overdue only', () => {
    expect(countActiveOpenItems(items)).toBe(1);
    expect(countActiveOpenItems(undefined)).toBe(0);
    expect(countActiveOpenItems([{ status: 'overdue' }, { status: 'open' }, { status: 'delivered' }])).toBe(2);
  });
});
