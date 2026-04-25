/**
 * useObservedWorkspaces tests — verify Phase C derivation rules:
 *  - one Workspace per observed teamId
 *  - DM rows ignored
 *  - first-seen ordering preserved
 *  - teamLabels override + safe fallback
 */

import { describe, it, expect } from 'vitest';
import type { Channel } from '../types/chat.types';
import { buildObservedWorkspaces } from './useObservedWorkspaces';

const ISO = '2026-04-25T20:00:00.000Z';

const makeChannel = (over: Partial<Channel>): Channel => ({
  id: 'ch',
  agentSession: '',
  name: 'general',
  createdAt: ISO,
  type: 'channel',
  ...over,
});

describe('buildObservedWorkspaces', () => {
  it('returns one workspace per unique teamId across channel rows', () => {
    const ws = buildObservedWorkspaces([
      makeChannel({ id: 'ch1', teamId: 'team-a', name: 'general' }),
      makeChannel({ id: 'ch2', teamId: 'team-a', name: 'proj-x' }),
      makeChannel({ id: 'ch3', teamId: 'team-b', name: 'general' }),
    ]);
    expect(ws.map((w) => w.id)).toEqual(['team-a', 'team-b']);
  });

  it('preserves first-seen order so the rail stays stable across re-renders', () => {
    const ws = buildObservedWorkspaces([
      makeChannel({ id: 'ch1', teamId: 'team-c' }),
      makeChannel({ id: 'ch2', teamId: 'team-a' }),
      makeChannel({ id: 'ch3', teamId: 'team-c' }),
      makeChannel({ id: 'ch4', teamId: 'team-b' }),
    ]);
    expect(ws.map((w) => w.id)).toEqual(['team-c', 'team-a', 'team-b']);
  });

  it('ignores DM rows entirely — they belong to no workspace', () => {
    const ws = buildObservedWorkspaces([
      { id: 'dm1', agentSession: 'a', name: 'Sam', createdAt: ISO, type: 'dm' },
      makeChannel({ id: 'ch1', teamId: 'team-a' }),
    ]);
    expect(ws.map((w) => w.id)).toEqual(['team-a']);
  });

  it('ignores channels with a missing or empty teamId', () => {
    const ws = buildObservedWorkspaces([
      makeChannel({ id: 'orphan', teamId: undefined }),
      makeChannel({ id: 'blank', teamId: '   ' }),
      makeChannel({ id: 'ch1', teamId: 'team-a' }),
    ]);
    expect(ws.map((w) => w.id)).toEqual(['team-a']);
  });

  it('uses teamLabels[id] when provided and falls back to the id otherwise', () => {
    const ws = buildObservedWorkspaces(
      [
        makeChannel({ id: 'ch1', teamId: 'team-product' }),
        makeChannel({ id: 'ch2', teamId: 'team-marketing' }),
      ],
      { teamLabels: { 'team-product': 'Crewly Product' } },
    );
    expect(ws[0].name).toBe('Crewly Product');
    // No label provided — fall back to the raw id so the rail still renders.
    expect(ws[1].name).toBe('team-marketing');
  });

  it('defaults the workspace kind to "team" so the rail renders the right glyph', () => {
    const ws = buildObservedWorkspaces([makeChannel({ id: 'ch1', teamId: 'team-a' })]);
    expect(ws[0].kind).toBe('team');
  });

  it('returns an empty array when no channels match', () => {
    expect(buildObservedWorkspaces([])).toEqual([]);
    expect(buildObservedWorkspaces([
      { id: 'dm1', agentSession: 'a', name: 'A', createdAt: ISO, type: 'dm' },
    ])).toEqual([]);
  });
});
