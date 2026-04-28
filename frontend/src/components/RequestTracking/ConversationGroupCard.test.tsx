// @vitest-environment jsdom
/**
 * Tests for ConversationGroupCard
 *
 * @module components/RequestTracking/ConversationGroupCard.test
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationGroupCard } from './ConversationGroupCard';

describe('ConversationGroupCard', () => {
  it('renders the conversation label and request count', () => {
    render(
      <ConversationGroupCard conversationLabel="slack-C123-1775336540.0000" requestCount={2}>
        <div>Row A</div>
        <div>Row B</div>
      </ConversationGroupCard>,
    );

    expect(screen.getByText('Source Conversation')).toBeInTheDocument();
    expect(screen.getByText('slack-C123-1775336540.0000')).toBeInTheDocument();
    expect(screen.getByText('2 requests')).toBeInTheDocument();
  });

  it('renders child content inside the group body', () => {
    render(
      <ConversationGroupCard conversationLabel="unlinked" requestCount={1}>
        <div>Only Row</div>
      </ConversationGroupCard>,
    );

    expect(screen.getByText('Only Row')).toBeInTheDocument();
  });
});
