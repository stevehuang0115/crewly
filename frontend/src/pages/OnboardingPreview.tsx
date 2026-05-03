/**
 * OnboardingPreview — internal /onboarding-preview route.
 *
 * Mounts the V2.5 OnboardingShell + BlueprintSidebar visual harness
 * stories so Mia + Steve can review the W1 layout / empty-state /
 * Progressive Reveal animation in a real browser without needing
 * Storybook.
 *
 * Route: `/onboarding-preview` (registered in App.tsx, OUTSIDE the
 * standard AppLayout so the preview takes the full viewport).
 *
 * @module pages/OnboardingPreview
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  BLUEPRINT_SIDEBAR_STORIES,
} from '../components/Onboarding/v2-5/stories/BlueprintSidebar.stories';
import {
  ONBOARDING_SHELL_STORIES,
} from '../components/Onboarding/v2-5/stories/OnboardingShell.stories';
import { OnboardingBlueprintProvider } from '../components/Onboarding/v2-5/OnboardingBlueprintContext';
import { BlueprintSidebar } from '../components/Onboarding/v2-5/BlueprintSidebar';
import {
  FIXTURE_ALL_EMPTY,
  FIXTURE_BUSINESS_PROFILE,
  FIXTURE_MATCH_REPORT,
  FIXTURE_ALL_POPULATED,
} from '../components/Onboarding/v2-5/stories/fixtures';

interface StoryEntry {
  id: string;
  label: string;
  render: () => ReactNode;
}

/** Combined story registry — sidebar + shell + the live-reveal demo. */
const STORIES: readonly StoryEntry[] = [
  ...BLUEPRINT_SIDEBAR_STORIES,
  ...ONBOARDING_SHELL_STORIES,
  {
    id: 'progressive-reveal-demo',
    label: 'Progressive Reveal · live demo',
    render: () => <ProgressiveRevealDemo />,
  },
];

/**
 * Progressive Reveal demo — clicks a "Next stage" button to walk
 * the Blueprint through S2 → S3 → S4 → S5 so Mia can see the
 * empty→populated CSS transition fire on each block.
 */
function ProgressiveRevealDemo(): ReactNode {
  const stages = [
    { label: 'S2 — empty', value: FIXTURE_ALL_EMPTY },
    { label: 'S3 — discovery', value: FIXTURE_BUSINESS_PROFILE },
    { label: 'S4 — match report', value: FIXTURE_MATCH_REPORT },
    { label: 'S5 — fully populated', value: FIXTURE_ALL_POPULATED },
  ];
  const [idx, setIdx] = useState(0);
  const stage = stages[idx];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={() => setIdx((prev) => Math.max(0, prev - 1))}
          disabled={idx === 0}
          data-testid="reveal-demo-prev"
        >
          ← Previous
        </button>
        <span style={{ fontWeight: 600 }}>{stage.label}</span>
        <button
          type="button"
          onClick={() =>
            setIdx((prev) => Math.min(stages.length - 1, prev + 1))
          }
          disabled={idx === stages.length - 1}
          data-testid="reveal-demo-next"
        >
          Next →
        </button>
      </div>
      <div style={{ width: 360, height: 640 }}>
        <OnboardingBlueprintProvider value={stage.value}>
          <BlueprintSidebar />
        </OnboardingBlueprintProvider>
      </div>
    </div>
  );
}

/**
 * Map `?stage=S2|S3|S4|S5` URL params to the matching shell story id.
 * Lets reviewers (Mia / Steve) deep-link to a specific stage without
 * clicking through the left-rail picker.
 */
const STAGE_TO_STORY_ID: Record<string, string> = {
  S2: 'shell-all-empty',
  S3: 'shell-business-profile',
  S4: 'shell-match-report',
  S5: 'shell-all-populated',
};

/**
 * Read `?stage=...` (and `?story=...`) from the URL. Returns the
 * matching STORIES entry id, or `undefined` if nothing maps. Tolerates
 * SSR-less envs (`window` undefined) and case-insensitive stage codes.
 */
function readInitialStoryIdFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const directStory = params.get('story');
  if (directStory && STORIES.some((s) => s.id === directStory)) {
    return directStory;
  }
  const stage = params.get('stage');
  if (stage) {
    const mapped = STAGE_TO_STORY_ID[stage.toUpperCase()];
    if (mapped && STORIES.some((s) => s.id === mapped)) {
      return mapped;
    }
  }
  return undefined;
}

/**
 * Read `?w=narrow|<pixels>` from the URL. When set, the preview wraps
 * the selected story in a fixed-width iframe so reviewers can see the
 * <1024px drawer-collapse layout without resizing their actual window.
 *
 * Returns the desired iframe width in px, or `undefined` to render at
 * full window width. `narrow` aliases to 768.
 */
function readNarrowWidthFromUrl(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('w');
  if (!raw) return undefined;
  if (raw.toLowerCase() === 'narrow') return 768;
  const px = Number(raw);
  return Number.isFinite(px) && px > 0 ? Math.min(px, 1023) : undefined;
}

/** Returns true if `?bare=1` is set — renders only the story, no chrome. */
function readBareFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = new URLSearchParams(window.location.search).get('bare');
  return raw === '1' || raw === 'true';
}

/**
 * Top-level preview page. Renders a left-rail story picker + the
 * selected story. Honours `?stage=S2..S5` and `?story=<id>` URL
 * params for deep-linking, plus `?w=narrow` to preview the
 * <1024px drawer-collapse layout in a width-constrained iframe and
 * `?bare=1` to render the story without the surrounding nav (used
 * by `?w=narrow` for its iframe src).
 */
export function OnboardingPreview(): ReactNode {
  const [selectedId, setSelectedId] = useState<string>(
    () => readInitialStoryIdFromUrl() ?? STORIES[0].id
  );
  const narrowWidth = readNarrowWidthFromUrl();
  const bare = readBareFromUrl();

  // Re-sync if the stage param changes after mount (e.g. user edits URL).
  useEffect(() => {
    const next = readInitialStoryIdFromUrl();
    if (next && next !== selectedId) {
      setSelectedId(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = STORIES.find((s) => s.id === selectedId) ?? STORIES[0];

  // `?bare=1` short-circuits the outer chrome — used by the narrow
  // iframe so the inner instance renders ONLY the story content.
  if (bare) {
    return (
      <div
        data-testid="onboarding-preview-bare"
        style={{
          height: '100vh',
          width: '100vw',
          fontFamily: 'system-ui, sans-serif',
          background: '#ffffff',
        }}
      >
        {selected.render()}
      </div>
    );
  }

  return (
    <div
      data-testid="onboarding-preview"
      style={{
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <nav
        data-testid="onboarding-preview-nav"
        style={{
          borderRight: '1px solid #e5e7eb',
          padding: 16,
          background: '#f9fafb',
          overflowY: 'auto',
        }}
      >
        <h1 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          Onboarding V2.5
        </h1>
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
          Internal preview — F1/F2 W1 shell. Mia hi-fi handoff target
          Friday W1 EOD.
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {STORIES.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelectedId(s.id)}
                data-testid={`onboarding-preview-pick-${s.id}`}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 6,
                  background: s.id === selectedId ? '#dbeafe' : 'transparent',
                  color: s.id === selectedId ? '#1d4ed8' : '#111827',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main
        data-testid="onboarding-preview-stage"
        style={{ padding: 24, overflow: 'auto', background: '#ffffff' }}
      >
        <header style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{selected.label}</h2>
          <code style={{ fontSize: 12, color: '#6b7280' }}>id: {selected.id}</code>
        </header>
        <div data-testid="onboarding-preview-render">
          {narrowWidth !== undefined ? (
            <NarrowFrame width={narrowWidth} storyId={selected.id} />
          ) : (
            selected.render()
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Renders the same story inside a width-constrained iframe so the
 * inner viewport hits the `@media (max-width: 1023px)` rules and the
 * BlueprintSidebar collapses into its off-canvas drawer form.
 *
 * The iframe loads `/onboarding-preview?story=<id>` (no `w=` param)
 * so the inner instance renders the story at full width *of the iframe*.
 */
function NarrowFrame({
  width,
  storyId,
}: {
  width: number;
  storyId: string;
}): ReactNode {
  const src = `/onboarding-preview?story=${encodeURIComponent(storyId)}&bare=1`;
  return (
    <div
      data-testid="onboarding-preview-narrow-frame"
      style={{
        width,
        height: 760,
        border: '1px dashed #9ca3af',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      <iframe
        src={src}
        title="Onboarding preview (narrow)"
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </div>
  );
}

export default OnboardingPreview;
