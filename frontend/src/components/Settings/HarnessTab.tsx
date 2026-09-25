/**
 * Settings → Harness tab
 *
 * Permanent home of the harness status list, the orchestrator harness
 * choice and the login cards (logins expire; people come back here to
 * re-login). Reuses the same components as the `/setup` flow.
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
    return <LoadingSpinner centered text="正在检查编程助手…" data-testid="harness-tab-loading" />;
  }

  if (!overview) {
    return (
      <Alert variant="error" title="无法读取编程助手状态 / Couldn't load harness status">
        <div className="space-y-2">
          <p>{error}</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
            重试 / Retry
          </Button>
        </div>
      </Alert>
    );
  }

  // Orc harness first, then the other installed ones.
  const loginHarnesses = overview.harnesses
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
          <SectionHeading title="编程助手" subtitle="Coding harnesses installed on this machine" />
          <Button type="button" size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refresh()}>
            刷新
          </Button>
        </div>
        <HarnessList
          harnesses={overview.harnesses}
          systemTools={overview.systemTools}
          onInstallFinished={() => void refresh()}
        />
      </section>

      <section>
        <SectionHeading title="Orc 使用的编程助手" subtitle="Which harness the orchestrator runs on" />
        <OrcHarnessPicker
          harnesses={overview.harnesses}
          value={overview.orcHarness}
          onChange={(id) => void setOrcHarness(id)}
          disabled={savingOrc}
        />
      </section>

      {loginHarnesses.length > 0 && (
        <section>
          <SectionHeading title="登录" subtitle="Sign in again here when a login expires" />
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
