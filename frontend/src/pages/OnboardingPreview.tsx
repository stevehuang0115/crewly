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

import { useState, type ReactNode } from 'react';
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
 * Top-level preview page. Renders a left-rail story picker + the
 * selected story.
 */
export function OnboardingPreview(): ReactNode {
  const [selectedId, setSelectedId] = useState<string>(STORIES[0].id);
  const selected = STORIES.find((s) => s.id === selectedId) ?? STORIES[0];

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
        <div data-testid="onboarding-preview-render">{selected.render()}</div>
      </main>
    </div>
  );
}

export default OnboardingPreview;
