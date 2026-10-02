/**
 * Settings Page
 *
 * Tabs (specs/2026-10-02-ui-redesign.md §Settings): General · Runtimes ·
 * Roles · API Keys · Credentials · Cloud & devices · Security · System,
 * kept in `?tab=` (the default General tab is left out of the URL).
 *
 * Moved out of Settings, with redirects so old links keep working:
 * - `?tab=skills` → Marketplace › Installed (`/marketplace?tab=installed`)
 * - `?tab=integrations` / `?tab=slack` → `/connections` (query carried over)
 * Moved in: Cloud & devices (former `/cloud`, the CloudPortal page) and Security (former `/security`, SecurityOverview).
 * Moved out: token usage, caps and boosts (former System › Usage) → `/usage`.
 *
 * Each tab follows the simplify rules: what people change is visible, the
 * rest sits under a collapsed "Advanced" or a row's "⋯".
 *
 * @module pages/Settings
 */

import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { PageHeader, UnderlineTabs } from '@crewly/ui';
import { GeneralTab } from '../components/Settings/GeneralTab';
import { RolesTab } from '../components/Settings/RolesTab';
import { ApiKeysTab } from '../components/Settings/ApiKeysTab';
import { CredentialsTab } from '../components/Settings/CredentialsTab';
import { SystemTab } from '../components/Settings/SystemTab';
import { RuntimesTab } from '../components/Settings/RuntimesTab';
import { CloudDevicesTab } from '../components/Settings/CloudDevicesTab';
import { SecurityTab } from '../components/Settings/SecurityTab';
import { useTabParam } from '../hooks/useTabParam';
import {
  SETTINGS_TABS,
  SETTINGS_TAB_ALIASES,
  settingsTabRedirect,
  type SettingsTabId,
} from '../constants/routes.constants';

/** Tab labels, in SETTINGS_TABS order. */
export const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = {
  general: 'General',
  runtimes: 'Runtimes',
  roles: 'Roles',
  'api-keys': 'API Keys',
  credentials: 'Credentials',
  cloud: 'Cloud & devices',
  security: 'Security',
  system: 'System',
};

/**
 * Panel content per tab id.
 *
 * @param tab - Tab id
 * @returns The panel
 */
function renderTabContent(tab: SettingsTabId): React.ReactNode {
  switch (tab) {
    case 'general':
      return <GeneralTab />;
    case 'runtimes':
      return <RuntimesTab />;
    case 'roles':
      return <RolesTab />;
    case 'api-keys':
      return <ApiKeysTab />;
    case 'credentials':
      return <CredentialsTab />;
    case 'cloud':
      return <CloudDevicesTab />;
    case 'security':
      return <SecurityTab />;
    case 'system':
      return <SystemTab />;
    default:
      return null;
  }
}

/**
 * Settings page, after any moved-tab redirect.
 *
 * @returns Settings with the active tab
 */
const SettingsTabs: React.FC = () => {
  const [tab, setTab] = useTabParam(SETTINGS_TABS, SETTINGS_TAB_ALIASES);

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Runtimes, keys, cloud and devices"
        tabs={
          <UnderlineTabs
            aria-label="Settings sections"
            idPrefix="settings"
            value={tab}
            onChange={(v) => setTab(v as SettingsTabId)}
            tabs={SETTINGS_TABS.map((id) => ({ value: id, label: SETTINGS_TAB_LABELS[id] }))}
          />
        }
      />
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} data-testid={`settings-panel-${tab}`}>
        {renderTabContent(tab)}
      </div>
    </div>
  );
};

/**
 * Settings route: forwards moved tabs, else shows the tabs.
 *
 * @returns Redirect or the page
 */
export const Settings: React.FC = () => {
  const { search } = useLocation();
  const redirect = settingsTabRedirect(search);
  if (redirect) return <Navigate to={redirect} replace />;
  return <SettingsTabs />;
};

export default Settings;
