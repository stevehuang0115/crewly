/**
 * Tests for the onboarding-mode system prompt v0.
 *
 * The prompt is a string constant that drives a 5-phase onboarding
 * conversation. These tests guard against accidental edits that strip
 * structural markers, the few-shot anchor, or the capability-grounding
 * language — all of which Steve and Sam called out as the differentiator.
 *
 * @module services/orchestrator/prompts/onboarding-mode.prompt.test
 */

import {
  ONBOARDING_MODE_SYSTEM_PROMPT,
  ONBOARDING_PHASE_MARKERS,
  ONBOARDING_CAPABILITY_MARKERS,
  ONBOARDING_FEW_SHOT_ANCHOR_MARKER,
  findMissingPromptMarkers,
} from './onboarding-mode.prompt.js';

describe('ONBOARDING_MODE_SYSTEM_PROMPT', () => {
  it('exports a non-empty string', () => {
    expect(typeof ONBOARDING_MODE_SYSTEM_PROMPT).toBe('string');
    expect(ONBOARDING_MODE_SYSTEM_PROMPT.length).toBeGreaterThan(1000);
  });

  it('contains every one of the 5 phase markers', () => {
    for (const marker of ONBOARDING_PHASE_MARKERS) {
      expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain(marker);
    }
  });

  it('contains all capability-grounding language markers (case-insensitive)', () => {
    const lower = ONBOARDING_MODE_SYSTEM_PROMPT.toLowerCase();
    for (const marker of ONBOARDING_CAPABILITY_MARKERS) {
      expect(lower).toContain(marker.toLowerCase());
    }
  });

  it('embeds the four feasibility tier glyphs (✅ 🤝 ⏳ ❌)', () => {
    for (const glyph of ['✅', '🤝', '⏳', '❌']) {
      expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain(glyph);
    }
  });

  it('embeds the few-shot anchor transcript header', () => {
    expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain(ONBOARDING_FEW_SHOT_ANCHOR_MARKER);
  });

  it('few-shot anchor names at least two concrete capability skills', () => {
    // The differentiator is naming the underlying skill, not vague claims.
    expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain('content-drafter');
    expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain('support-triage');
  });

  it('lists every allowed skill in onboarding mode', () => {
    const allowed = [
      'recall',
      'remember',
      'record-learning',
      'recommend-team',
      'materialize-team',
      'report-status',
    ];
    for (const skill of allowed) {
      expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain(skill);
    }
  });

  it('explicitly forbids spawn-worker skills', () => {
    for (const forbidden of ['delegate-task', 'start-agent', 'stop-agent']) {
      expect(ONBOARDING_MODE_SYSTEM_PROMPT).toContain(forbidden);
    }
  });

  it('opens with a ~5 minute time budget statement', () => {
    expect(ONBOARDING_MODE_SYSTEM_PROMPT).toMatch(/5\s*minutes|~5\s*min|≈5\s*min/i);
  });
});

describe('findMissingPromptMarkers()', () => {
  it('returns empty array for the canonical prompt', () => {
    expect(findMissingPromptMarkers(ONBOARDING_MODE_SYSTEM_PROMPT)).toEqual([]);
  });

  it('returns every marker for an empty prompt', () => {
    const missing = findMissingPromptMarkers('');
    // 5 phase + 3 capability + 1 anchor = 9
    const expected =
      ONBOARDING_PHASE_MARKERS.length + ONBOARDING_CAPABILITY_MARKERS.length + 1;
    expect(missing.length).toBe(expected);
  });

  it('reports just the dropped marker when one is removed', () => {
    const stripped = ONBOARDING_MODE_SYSTEM_PROMPT.replace(
      'PHASE 3 — FEASIBILITY JUDGMENT',
      '',
    );
    expect(findMissingPromptMarkers(stripped)).toEqual([
      'PHASE 3 — FEASIBILITY JUDGMENT',
    ]);
  });
});
