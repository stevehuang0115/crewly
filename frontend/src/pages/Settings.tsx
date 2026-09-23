/**
 * Settings Page
 *
 * Main settings page with tab navigation for General, Roles, Skills, Integrations,
 * API Keys, and System sections. Cloud management has been consolidated into the
 * dedicated Cloud Portal page (/cloud).
 *
 * If a user navigates to /settings?tab=cloud, they are redirected to /cloud.
 *
 * @module pages/Settings
 */

import React, { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, User, Wrench, Link2, Key, Monitor, Lock, LucideIcon } from 'lucide-react';
import { Tabs, TabList, TabTrigger, TabContent } from '@crewly/ui';
import { GeneralTab } from '../components/Settings/GeneralTab';
import { RolesTab } from '../components/Settings/RolesTab';
import { SkillsTab } from '../components/Settings/SkillsTab';
import { IntegrationsTab } from '../components/Settings/IntegrationsTab';
import { ApiKeysTab } from '../components/Settings/ApiKeysTab';
import { CredentialsTab } from '../components/Settings/CredentialsTab';
import { SystemTab } from '../components/Settings/SystemTab';

/**
 * Available settings tabs (Cloud removed -- consolidated to /cloud)
 */
type SettingsTab = 'general' | 'roles' | 'skills' | 'integrations' | 'api-keys' | 'credentials' | 'system';

/**
 * Tab configuration
 */
interface TabConfig {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
}

/** Valid tab IDs for URL parameter validation */
const VALID_TABS: ReadonlySet<string> = new Set<SettingsTab>(['general', 'roles', 'skills', 'integrations', 'api-keys', 'credentials', 'system']);

/**
 * Settings page with tabbed navigation for managing Crewly configuration.
 *
 * Redirects /settings?tab=cloud to /cloud since Cloud management is now
 * exclusively handled by the Cloud Portal page.
 *
 * @returns Settings page component
 */
export const Settings: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const tabParam = searchParams.get('tab');

  // Redirect ?tab=cloud to the dedicated Cloud Portal page
  useEffect(() => {
    if (tabParam === 'cloud') {
      navigate('/cloud', { replace: true });
    }
  }, [tabParam, navigate]);

  // `?tab=slack` is the return URL of the Cloud Slack install flow — the
  // Slack card lives inside Integrations.
  const initialTab: SettingsTab =
    tabParam === 'slack' ? 'integrations' : tabParam && VALID_TABS.has(tabParam) ? (tabParam as SettingsTab) : 'general';

  const tabs: TabConfig[] = [
    { id: 'general', label: 'General', icon: SettingsIcon },
    { id: 'roles', label: 'Roles', icon: User },
    { id: 'skills', label: 'Skills', icon: Wrench },
    { id: 'integrations', label: 'Integrations', icon: Link2 },
    { id: 'api-keys', label: 'API Keys', icon: Key },
    { id: 'credentials', label: 'Credentials', icon: Lock },
    { id: 'system', label: 'System', icon: Monitor },
  ];

  /** Panel content per tab id. */
  const renderTabContent = (tab: SettingsTab): React.ReactNode => {
    switch (tab) {
      case 'general':
        return <GeneralTab />;
      case 'roles':
        return <RolesTab />;
      case 'skills':
        return <SkillsTab />;
      case 'integrations':
        return <IntegrationsTab />;
      case 'api-keys':
        return <ApiKeysTab />;
      case 'credentials':
        return <CredentialsTab />;
      case 'system':
        return <SystemTab />;
      default:
        return null;
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-text-secondary-dark mt-1">
          Configure Crewly behavior and manage roles and skills
        </p>
      </div>

      {/* Tab Navigation + Content */}
      <Tabs defaultValue={initialTab}>
        <TabList className="overflow-x-auto">
          {tabs.map((tab) => (
            <TabTrigger key={tab.id} value={tab.id} icon={<tab.icon className="w-4 h-4" />}>
              <span>{tab.label}</span>
            </TabTrigger>
          ))}
        </TabList>
        {tabs.map((tab) => (
          <TabContent key={tab.id} value={tab.id}>
            {renderTabContent(tab.id)}
          </TabContent>
        ))}
      </Tabs>
    </div>
  );
};

export default Settings;
