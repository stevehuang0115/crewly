/**
 * Settings › Runtimes
 *
 * One row per runtime with a status word ("Ready", "Sign-in needed", "Out of
 * usage", "Update available", "Not installed") and its one action (Sign in,
 * Update, Install); the rest of a runtime's actions sit behind "⋯" (sign in
 * again, test it, install log, details). Then which runtime the orchestrator
 * runs on, and the fallback order. Terms, per-agent orders, the orchestrator
 * rule and the runtime test are under Advanced.
 *
 * Matches the approved simple/Settings-Runtimes artboard
 * (specs/2026-10-02-ui-redesign.md). Replaces the former HarnessTab and keeps
 * everything it had: harness install/update with the live log, sign-in cards
 * (logins expire; people come back here), the orc harness choice, Terms
 * consent (specs/2026-10-01-runtime-terms-consent.md) and the fallback with
 * its smoke test (specs/2026-10-01-runtime-fallback.md).
 *
 * @module components/Settings/RuntimesTab
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FlaskConical, Info, KeyRound, LogIn, MoreHorizontal, RefreshCw, ScrollText } from 'lucide-react';
import { Alert, Button, CollapsibleSection, IconButton, LoadingSpinner, OverflowMenu, StatusLabel, type OverflowMenuItem, type StatusTone } from '@crewly/ui';
import { useHarnessStatus } from '../../hooks/useHarnessStatus';
import { useInstallJob } from '../../hooks/useInstallJob';
import { useRuntimeFallback, isTestRunning, type UseRuntimeFallbackResult } from '../../hooks/useRuntimeFallback';
import { HarnessLoginCard } from '../Harness/HarnessLoginCard';
import { InstallLog } from '../Harness/InstallLog';
import { OrcHarnessPicker } from '../Harness/OrcHarnessPicker';
import { LOGIN_STATE_BADGES, harnessDisplayName, visibleHarnesses } from '../../constants/harness.constants';
import { LINKS } from '../../constants/routes.constants';
import type { HarnessId, HarnessStatus } from '../../types/harness.types';
import type { RuntimeAvailability, RuntimeFallbackState } from '../../services/runtime-fallback.service';
import { RuntimeTermsPanel } from './RuntimeTermsPanel';
import {
  FallbackOrderSection,
  FallbackSaveBar,
  OrcFollowsToggle,
  PerAgentOrderSection,
  RuntimeSmokeTest,
  SmokeTestResult,
  formatResetTime,
  testableRuntimes,
} from './RuntimeFallbackPanel';

/** Status word and tone of a runtime row. */
export interface RuntimeRowStatus {
  word: string;
  tone: StatusTone;
}

/**
 * Status of a harness, most urgent first.
 *
 * @param h - Harness
 * @param avail - Its fallback availability, when known
 * @returns Word and tone
 */
export function harnessRowStatus(h: HarnessStatus, avail?: RuntimeAvailability): RuntimeRowStatus {
  if (!h.installed) return { word: 'Not installed', tone: 'neutral' };
  if (avail?.exhausted) return { word: 'Out of usage', tone: 'attention' };
  if (h.loginState === 'logged_out' || h.reloginPending) return { word: 'Sign-in needed', tone: 'attention' };
  if (avail?.termsBlocked) return { word: 'Terms not accepted', tone: 'attention' };
  if (h.updateAvailable) return { word: 'Update available', tone: 'attention' };
  if (h.loginState === 'unknown') return { word: LOGIN_STATE_BADGES.unknown.label, tone: 'neutral' };
  return { word: 'Ready', tone: 'success' };
}

/**
 * Quiet meta line of a runtime: why it is out, who it moved, what it runs.
 *
 * @param runtime - Runtime id
 * @param state - Fallback state
 * @param extra - Other facts (orchestrator, retired, …)
 * @returns Text, or empty
 */
export function runtimeMeta(runtime: string, state: RuntimeFallbackState | null, extra: string[] = []): string {
  const parts = [...extra];
  const ex = state?.exhausted.find((e) => e.runtime === runtime);
  if (ex) {
    const moved = state?.overrides.filter((o) => o.primary === runtime) ?? [];
    if (ex.until) parts.push(`Resets ~${formatResetTime(ex.until)}`);
    if (moved.length > 0) parts.push(`${moved.length} agent${moved.length === 1 ? '' : 's'} on ${[...new Set(moved.map((o) => o.runtimeLabel))].join(' / ')} until then`);
    else if (ex.noFallback) parts.push('No fallback runtime is available');
  }
  return parts.join(' · ');
}

/** Props of {@link HarnessRow}. */
interface HarnessRowProps {
  harness: HarnessStatus;
  isOrc: boolean;
  fb: UseRuntimeFallbackResult;
  onRefresh: () => void;
  onHarnessUpdated: (status: HarnessStatus) => void;
}

/**
 * One coding harness.
 *
 * @param props - {@link HarnessRowProps}
 * @returns Row with its expandable panels
 */
const HarnessRow: React.FC<HarnessRowProps> = ({ harness, isOrc, fb, onRefresh, onHarnessUpdated }) => {
  const { job, error: installError, running, start } = useInstallJob(harness.id, () => onRefresh());
  const [panel, setPanel] = useState<'signin' | 'relogin' | 'log' | 'details' | null>(null);
  const avail = fb.state?.runtimes.find((r) => r.runtime === harness.id);
  const status = running ? { word: 'Installing…', tone: 'primary' as StatusTone } : harnessRowStatus(harness, avail);
  const canSignIn = harness.installed && harness.loginMethods.length > 0;
  const needsSignIn = harness.installed && (harness.loginState === 'logged_out' || Boolean(harness.reloginPending));
  const canTest = Boolean(avail && testableRuntimes([avail]).length > 0);
  const toggle = (p: typeof panel): void => setPanel((cur) => (cur === p ? null : p));

  const extra: string[] = [];
  if (isOrc) extra.push('Runs the orchestrator');
  if (harness.reloginPending) extra.push('Sign-in started over Slack, waiting for you');
  if (harness.retired) extra.push('Enterprise accounts only');
  if (harness.installed && harness.loginMethods.length === 0 && harness.loginState !== 'logged_in') extra.push('Sign in from a terminal');
  if (avail?.termsBlocked && avail.reason) extra.push(avail.reason);
  const meta = runtimeMeta(harness.id, fb.state, extra);

  // One visible action, most useful first.
  let primary: React.ReactNode = null;
  let primaryKind: 'install' | 'signin' | 'update' | null = null;
  if (!harness.installed || job?.state === 'failed') {
    primaryKind = 'install';
    primary = (
      <Button type="button" size="xs" variant="outline" icon={Download} loading={running} onClick={() => void start().then(() => setPanel('log'))}>
        {job?.state === 'failed' ? 'Retry install' : 'Install'}
      </Button>
    );
  } else if (needsSignIn && canSignIn) {
    primaryKind = 'signin';
    primary = (
      <Button type="button" size="xs" variant="outline" icon={LogIn} onClick={() => toggle('signin')}>
        Sign in
      </Button>
    );
  } else if (harness.updateAvailable) {
    primaryKind = 'update';
    primary = (
      <Button type="button" size="xs" variant="outline" icon={RefreshCw} loading={running} onClick={() => void start().then(() => setPanel('log'))}>
        {running ? 'Installing…' : 'Update'}
      </Button>
    );
  }

  const menu: OverflowMenuItem[] = [];
  if (canSignIn && primaryKind !== 'signin') menu.push({ label: needsSignIn ? 'Sign in' : 'Sign in again', icon: LogIn, onClick: () => toggle(needsSignIn ? 'signin' : 'relogin') });
  if (harness.installed && harness.updateAvailable && primaryKind !== 'update' && primaryKind !== 'install') {
    menu.push({ label: 'Update', icon: RefreshCw, disabled: running, onClick: () => void start().then(() => setPanel('log')) });
  }
  if (canTest) menu.push({ label: isTestRunning(fb.tests[harness.id]) ? 'Testing…' : 'Test this runtime', icon: FlaskConical, disabled: isTestRunning(fb.tests[harness.id]), onClick: () => void fb.runTest(harness.id) });
  if (job) menu.push({ label: panel === 'log' ? 'Hide install log' : 'Install log', icon: ScrollText, onClick: () => toggle('log') });
  menu.push({ label: panel === 'details' ? 'Hide details' : 'Details', icon: Info, onClick: () => toggle('details') });

  return (
    <div className="border-b border-border-soft last:border-b-0" data-testid={`runtime-row-${harness.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:flex-nowrap">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-text">{harnessDisplayName(harness)}</span>
            <StatusLabel tone={status.tone} size="sm" data-testid={`runtime-status-${harness.id}`}>
              {status.word}
            </StatusLabel>
          </p>
          {meta && <p className="mt-0.5 truncate text-[13px] text-text-2">{meta}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {primary}
          <OverflowMenu items={menu} icon={MoreHorizontal} label={`More for ${harness.displayName}`} />
        </div>
      </div>

      {(fb.tests[harness.id] || installError || job || panel) && (
        <div className="flex flex-col gap-3 pb-4">
          <SmokeTestResult fb={fb} runtime={harness.id} testId={`runtime-row-test-${harness.id}`} />
          {installError && (
            <Alert variant="error" size="sm">
              {installError}
            </Alert>
          )}
          {job?.state === 'succeeded' && (
            <p className="text-[13px] text-success">{job.usedUserPrefix ? 'Installed to your user folder (no admin rights needed).' : `${harness.displayName} is ready.`}</p>
          )}
          {job?.state === 'failed' && !installError && <p className="text-[13px] text-danger">Install failed. Check the install log and try again.</p>}
          {job && (panel === 'log' || running) && <InstallLog log={job.log} />}
          {(panel === 'signin' || panel === 'relogin') && (
            <HarnessLoginCard harness={harness} startInRelogin={panel === 'relogin'} onLoggedIn={onRefresh} onHarnessUpdated={onHarnessUpdated} />
          )}
          {panel === 'details' && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2" data-testid={`runtime-details-${harness.id}`}>
              <div className="flex gap-2">
                <dt className="text-text-2">Version</dt>
                <dd className="text-text">{harness.installed ? (harness.version ?? 'unknown') : 'Not installed'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-text-2">Latest</dt>
                <dd className="text-text">{harness.latestVersion ?? 'unknown'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-text-2">Sign-in</dt>
                <dd className="text-text">
                  {harness.installed ? LOGIN_STATE_BADGES[harness.loginState].label : '—'}
                  {harness.loginSource ? ` via ${harness.loginSource}` : ''}
                </dd>
              </div>
              {avail && (
                <div className="flex gap-2">
                  <dt className="text-text-2">Fallback</dt>
                  <dd className="text-text">{avail.selectable ? 'Can be a fallback' : (avail.reason ?? 'Not available')}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
};

/** Props of {@link OtherRuntimeRow}. */
interface OtherRuntimeRowProps {
  runtime: RuntimeAvailability;
  fb: UseRuntimeFallbackResult;
}

/**
 * A runtime that is not a CLI harness (Crewly Agent on DeepSeek, OpenCode).
 *
 * @param props - {@link OtherRuntimeRowProps}
 * @returns Row
 */
const OtherRuntimeRow: React.FC<OtherRuntimeRowProps> = ({ runtime, fb }) => {
  const navigate = useNavigate();
  const status: RuntimeRowStatus = runtime.exhausted
    ? { word: 'Out of usage', tone: 'attention' }
    : runtime.selectable
      ? { word: 'Ready', tone: 'success' }
      : runtime.termsBlocked
        ? { word: 'Terms not accepted', tone: 'attention' }
        : { word: 'Not available', tone: 'neutral' };
  const meta = runtimeMeta(runtime.runtime, fb.state, !runtime.selectable && runtime.reason ? [runtime.reason] : []);
  const running = isTestRunning(fb.tests[runtime.runtime]);
  const menu: OverflowMenuItem[] = [];
  if (testableRuntimes([runtime]).length > 0) menu.push({ label: running ? 'Testing…' : 'Test this runtime', icon: FlaskConical, disabled: running, onClick: () => void fb.runTest(runtime.runtime) });
  if (runtime.runtime === 'crewly-agent') menu.push({ label: 'Change API key', icon: KeyRound, onClick: () => navigate(LINKS.settingsTab('api-keys')) });
  return (
    <div className="border-b border-border-soft last:border-b-0" data-testid={`runtime-row-${runtime.runtime}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:flex-nowrap">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-text">{runtime.label}</span>
            <StatusLabel tone={status.tone} size="sm" data-testid={`runtime-status-${runtime.runtime}`}>
              {status.word}
            </StatusLabel>
          </p>
          {meta && <p className="mt-0.5 truncate text-[13px] text-text-2">{meta}</p>}
        </div>
        {menu.length > 0 && <OverflowMenu items={menu} icon={MoreHorizontal} label={`More for ${runtime.label}`} />}
      </div>
      {fb.tests[runtime.runtime] && (
        <div className="pb-4">
          <SmokeTestResult fb={fb} runtime={runtime.runtime} testId={`runtime-row-test-${runtime.runtime}`} />
        </div>
      )}
    </div>
  );
};

/** Props of {@link RuntimesTab}. */
export interface RuntimesTabProps {
  /** Poll interval of a running smoke test (tests shorten it) */
  smokePollMs?: number;
}

/**
 * Runtimes tab.
 *
 * @param props - {@link RuntimesTabProps}
 * @returns Tab content
 */
export const RuntimesTab: React.FC<RuntimesTabProps> = ({ smokePollMs }) => {
  const { overview, loading, error, refresh, setOrcHarness, savingOrc, replaceHarness } = useHarnessStatus();
  const fb = useRuntimeFallback(smokePollMs);
  const [changingOrc, setChangingOrc] = useState(false);

  if (loading) {
    return <LoadingSpinner centered text="Checking runtimes…" data-testid="harness-tab-loading" />;
  }

  if (!overview) {
    return (
      <Alert variant="error" title="Couldn't load the runtimes">
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
  const harnessIds = new Set<string>(overview.harnesses.map((h) => h.id));
  const others = (fb.state?.runtimes ?? []).filter(
    (r) => !harnessIds.has(r.runtime) && (r.selectable || r.exhausted || r.termsBlocked || fb.draft?.chain.includes(r.runtime)),
  );
  const orc = overview.harnesses.find((h) => h.id === overview.orcHarness);
  const missingTools = overview.systemTools.filter((t) => !t.installed);

  return (
    <div className="flex max-w-3xl flex-col gap-8" data-testid="harness-tab">
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}

      <section aria-labelledby="runtimes-heading" className="flex flex-col">
        <div className="flex items-center justify-between gap-3">
          <h2 id="runtimes-heading" className="text-[15px] font-semibold text-text">
            Runtimes
          </h2>
          <IconButton icon={RefreshCw} size="icon" aria-label="Refresh runtimes" title="Refresh" onClick={() => void refresh()} />
        </div>
        <div className="flex flex-col">
          {harnesses.map((h) => (
            <HarnessRow key={h.id} harness={h} isOrc={h.id === overview.orcHarness} fb={fb} onRefresh={() => void refresh()} onHarnessUpdated={replaceHarness} />
          ))}
          {others.map((r) => (
            <OtherRuntimeRow key={r.runtime} runtime={r} fb={fb} />
          ))}
        </div>
        {missingTools.map((tool) => (
          <p key={tool.id} className="mt-2 text-[13px] text-attention" data-testid={`missing-tool-${tool.id}`}>
            Missing system tool {tool.id}: some skills need it. Install with <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">{tool.installHint}</code>
          </p>
        ))}
        <div className="mt-3 flex flex-col gap-3 border-t border-border-soft pt-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-text-2" data-testid="orc-runtime-line">
              {orc ? (
                <>
                  The orchestrator runs on <span className="font-semibold text-text">{harnessDisplayName(orc)}</span>
                </>
              ) : (
                'No coding harness is chosen for the orchestrator yet.'
              )}
            </p>
            <Button type="button" size="xs" variant="ghost" aria-expanded={changingOrc} onClick={() => setChangingOrc((v) => !v)}>
              {changingOrc ? 'Done' : 'Change'}
            </Button>
          </div>
          {changingOrc && (
            <OrcHarnessPicker harnesses={overview.harnesses} value={overview.orcHarness} onChange={(id: HarnessId) => void setOrcHarness(id)} disabled={savingOrc} />
          )}
        </div>
      </section>

      <section aria-labelledby="fallback-heading">
        {fb.state && fb.draft ? (
          <FallbackOrderSection fb={fb} />
        ) : fb.error ? (
          <Alert variant="error" title="Couldn't load the fallback settings">
            <div className="space-y-2">
              <p>{fb.error}</p>
              <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void fb.load()}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : (
          <LoadingSpinner centered text="Loading fallback settings…" />
        )}
        {fb.state && fb.error && (
          <Alert variant="error" size="sm" className="mt-3">
            {fb.error}
          </Alert>
        )}
      </section>

      <CollapsibleSection title="Advanced" summary="Terms, per-agent order, orchestrator fallback, test a runtime" data-testid="runtimes-advanced">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div>
              <p className="text-[15px] font-semibold text-text">Terms of service</p>
              <p className="text-[13px] text-text-2">Runtimes that ask you to accept their vendor&apos;s terms once. Crewly never accepts them for you.</p>
            </div>
            <RuntimeTermsPanel />
          </div>
          {fb.state && fb.draft && (
            <>
              <PerAgentOrderSection fb={fb} />
              <OrcFollowsToggle fb={fb} />
              <RuntimeSmokeTest fb={fb} />
              <FallbackSaveBar fb={fb} onlyWhenDirty testId="runtime-fallback-save-advanced" />
            </>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
};

export default RuntimesTab;
