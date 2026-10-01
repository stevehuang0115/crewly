/**
 * Settings → Runtimes tab (id `harness`)
 *
 * Permanent home of the harness status list, the orchestrator harness
 * choice and the login cards (logins expire; people come back here to
 * re-login). Reuses the same components as the `/setup` flow. Also holds the
 * runtime fallback settings and the per-runtime smoke test
 * (specs/2026-10-01-runtime-fallback.md), and the owner's consent to a
 * runtime's first-run Terms (specs/2026-10-01-runtime-terms-consent.md).
 *
 * @module components/Settings/HarnessTab
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, Button, LoadingSpinner } from '@crewly/ui';
import { useHarnessStatus } from '../../hooks/useHarnessStatus';
import { HarnessList } from '../Harness/HarnessList';
import { OrcHarnessPicker } from '../Harness/OrcHarnessPicker';
import { HarnessLoginCard } from '../Harness/HarnessLoginCard';
import { visibleHarnesses } from '../../constants/harness.constants';
import { RuntimeFallbackPanel } from './RuntimeFallbackPanel';
import { RuntimeTermsPanel } from './RuntimeTermsPanel';

/**
 * Section heading with Chinese title and short English subtitle.
 *
 * @param props - Title and subtitle
 * @returns Heading block
 */
const SectionHeading: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => (
  <div className="mb-3">
    <h2 className="text-lg font-semibold text-text-primary-dark">{title}</h2>
    <p className="text-sm text-text-secondary-dark">{subtitle}</p>
  </div>
);

/**
 * Harness settings: install status, orc choice, logins.
 *
 * @returns Tab content
 */
export const HarnessTab: React.FC = () => {
  const { overview, loading, error, refresh, setOrcHarness, savingOrc, replaceHarness } = useHarnessStatus();

  if (loading) {
    return <LoadingSpinner centered text="Checking coding harnesses…" data-testid="harness-tab-loading" />;
  }

  if (!overview) {
    return (
      <Alert variant="error" title="Couldn't load harness status">
        <div className="space-y-2">
          <p>{error}</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  // Gemini CLI is retired: listed only when it is already in use here.
  const harnesses = visibleHarnesses(overview.harnesses, overview.orcHarness);
  // Orc harness first, then the other installed ones.
  const loginHarnesses = harnesses
    .filter((h) => h.installed)
    .sort((a, b) => Number(b.id === overview.orcHarness) - Number(a.id === overview.orcHarness));

  return (
    <div className="space-y-8 max-w-3xl" data-testid="harness-tab">
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}

      <section>
        <div className="flex items-start justify-between gap-3">
          <SectionHeading title="Coding harnesses" subtitle="Installed on this machine" />
          <Button type="button" size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
        <HarnessList
          harnesses={harnesses}
          systemTools={overview.systemTools}
          onInstallFinished={() => void refresh()}
        />
      </section>

      <section>
        <SectionHeading title="Orc harness" subtitle="Which harness the orchestrator runs on" />
        <OrcHarnessPicker
          harnesses={overview.harnesses}
          value={overview.orcHarness}
          onChange={(id) => void setOrcHarness(id)}
          disabled={savingOrc}
        />
      </section>

      <section>
        <SectionHeading title="Terms of Service" subtitle="Runtimes that ask you to accept their vendor's terms once (Crewly never accepts them for you)" />
        <RuntimeTermsPanel />
      </section>

      <section>
        <SectionHeading title="Fallback" subtitle="Where agents go when a runtime runs out of usage, and back when it resets" />
        <RuntimeFallbackPanel />
      </section>

      {loginHarnesses.length > 0 && (
        <section>
          <SectionHeading title="Sign in" subtitle="Sign in again here when a login expires" />
          <div className="space-y-3">
            {loginHarnesses.map((h) => (
              <HarnessLoginCard
                key={h.id}
                harness={h}
                onLoggedIn={() => void refresh()}
                onHarnessUpdated={replaceHarness}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
