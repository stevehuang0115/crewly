/**
 * Tests for the simplified chat conversation list.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ConversationGroup, ConversationRow } from '@crewly/chat-ui';
import { ChatConversationList, visibleRows, rowDetails, DM_VISIBLE, CHANNEL_VISIBLE } from './ChatConversationList';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const dm = (i: number, over: Partial<ConversationRow> = {}): ConversationRow => ({ id: `dm-${i}`, kind: 'dm', title: `Agent ${i}`, agentSession: `s-${i}`, ...over });
const ch = (i: number, at?: string): ConversationRow => ({ id: `ch-${i}`, kind: 'channel', title: `team-${i}`, lastMessageAt: at });

describe('visibleRows', () => {
  it('DMs: keepers always, then fill to the cap', () => {
    const group: ConversationGroup = { id: 'dms', label: 'Direct messages', rows: Array.from({ length: 12 }, (_, i) => dm(i)) };
    const shown = visibleRows(group, (r) => r.id === 'dm-11', NOW);
    expect(shown).toHaveLength(DM_VISIBLE);
    expect(shown.map((r) => r.id)).toContain('dm-11');
  });

  it('channels: active (last week) or kept, capped; the first three when none is active', () => {
    const recent = '2026-10-01T12:00:00Z';
    const old = '2026-08-01T12:00:00Z';
    const group: ConversationGroup = { id: 'channels', label: 'Channels', rows: [ch(0, old), ...Array.from({ length: 7 }, (_, i) => ch(i + 1, recent))] };
    const shown = visibleRows(group, () => false, NOW);
    expect(shown).toHaveLength(CHANNEL_VISIBLE);
    expect(shown.map((r) => r.id)).not.toContain('ch-0');
    const quiet: ConversationGroup = { id: 'channels', label: 'Channels', rows: Array.from({ length: 5 }, (_, i) => ch(i, old)) };
    expect(visibleRows(quiet, () => false, NOW).map((r) => r.id)).toEqual(['ch-0', 'ch-1', 'ch-2']);
  });

  it('pinned shows everything', () => {
    const group: ConversationGroup = { id: 'pinned', label: 'Pinned', rows: Array.from({ length: 9 }, (_, i) => dm(i)) };
    expect(visibleRows(group, () => false, NOW)).toHaveLength(9);
  });
});

describe('ChatConversationList', () => {
  const groups: ConversationGroup[] = [
    { id: 'channels', label: 'Channels', rows: [ch(1, '2026-10-02T11:00:00Z')] },
    { id: 'dms', label: 'Direct messages', rows: [dm(1, { subtitle: 'developer', badge: 'Lead', presence: 'online' }), dm(2)] },
    { id: 'pinned', label: 'Pinned', rows: [dm(9, { title: 'Orchestrator' })] },
  ];
  const base = {
    groups,
    activeConversationId: 'dm-9',
    onSelectConversation: vi.fn(),
    isUnread: (r: ConversationRow) => r.id === 'dm-2',
    isPinned: (r: ConversationRow) => r.id === 'dm-9',
    onTogglePin: vi.fn(),
    onNewGroup: vi.fn(),
    now: NOW,
  };

  it('orders Pinned · DMs · Channels; names with an unread dot; details in the tooltip', () => {
    render(<ChatConversationList {...base} />);
    const sections = Array.from(document.querySelectorAll('h3')).map((h) => h.textContent);
    expect(sections).toEqual(['Pinned', 'Direct messages', 'Channels']);
    expect(screen.getByTestId('conv-unread-dm-2')).toBeInTheDocument();
    expect(screen.queryByTestId('conv-unread-dm-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('conv-row-dm-1')).toHaveAttribute('title', 'developer · Lead · online');
    expect(screen.getByTestId('conv-row-dm-9')).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByTestId('conv-row-ch-1')).getByText('#')).toBeInTheDocument();
  });

  it('selects, pins, starts a group chat', () => {
    render(<ChatConversationList {...base} />);
    fireEvent.click(screen.getByTestId('conv-row-dm-1'));
    expect(base.onSelectConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'dm-1' }));
    fireEvent.click(screen.getByTestId('conv-pin-dm-1'));
    expect(base.onTogglePin).toHaveBeenCalledWith(expect.objectContaining({ id: 'dm-1' }));
    expect(screen.getByTestId('conv-pin-dm-9')).toHaveAttribute('aria-label', 'Unpin Orchestrator');
    fireEvent.click(screen.getByTestId('new-group-button'));
    expect(base.onNewGroup).toHaveBeenCalled();
  });

  it('Find filters across sections and says when nothing matches', () => {
    render(<ChatConversationList {...base} />);
    fireEvent.click(screen.getByTestId('conv-search-toggle'));
    fireEvent.change(screen.getByTestId('conv-search'), { target: { value: 'team' } });
    expect(within(screen.getByTestId('conv-search-results')).getAllByTestId(/^conv-row-/)).toHaveLength(1);
    fireEvent.change(screen.getByTestId('conv-search'), { target: { value: 'zzz' } });
    expect(screen.getByText('No conversations match your search.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('conv-search'), { key: 'Escape' });
    expect(screen.queryByTestId('conv-search')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no conversations', () => {
    render(<ChatConversationList {...base} groups={[]} emptyState="Nothing yet" />);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });

  it('rowDetails joins role, Lead and DM presence', () => {
    expect(rowDetails(dm(1))).toBeUndefined();
    expect(rowDetails(ch(1))).toBeUndefined();
  });
});
