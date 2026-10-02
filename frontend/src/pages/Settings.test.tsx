/**
 * Tests for Settings Page (specs/2026-10-02-ui-redesign.md §Settings):
 * the eight tabs in `?tab=`, the Cloud & devices and Security tabs that
 * moved in, and the redirects for the tabs that moved out.
 *
 * @module pages/Settings.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi, describe, it, expect } from 'vitest';
import { Settings } from './Settings';

vi.mock('../components/Settings/GeneralTab', () => ({
  GeneralTab: () => <div data-testid="general-tab">General Tab Content</div>,
}));
vi.mock('../components/Settings/RolesTab', () => ({
  RolesTab: () => <div data-testid="roles-tab">Roles Tab Content</div>,
}));
vi.mock('../components/Settings/PeopleTab', () => ({
  PeopleTab: () => <div data-testid="people-tab">People</div>,
}));
vi.mock('../components/Settings/ApiKeysTab', () => ({
  ApiKeysTab: () => <div data-testid="api-keys-tab">API Keys Tab Content</div>,
}));
vi.mock('../components/Settings/CredentialsTab', () => ({
  CredentialsTab: () => <div data-testid="credentials-tab">Credentials Tab Content</div>,
}));
vi.mock('../components/Settings/SystemTab', () => ({
  SystemTab: () => <div data-testid="system-tab">System Tab Content</div>,
}));
vi.mock('../components/Settings/RuntimesTab', () => ({
  RuntimesTab: () => <div data-testid="harness-tab">Runtimes Tab Content</div>,
}));
vi.mock('../components/Settings/CloudDevicesTab', () => ({
  CloudDevicesTab: () => <div data-testid="cloud-portal">Cloud & devices Content</div>,
}));
vi.mock('../components/Settings/SecurityTab', () => ({
  SecurityTab: () => <div data-testid="security-overview">Security Content</div>,
}));

/** Shows where the router ended up. */
const Where: React.FC = () => {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{`${pathname}${search}`}</div>;
};

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/settings" element={<><Settings /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Settings Page', () => {
  it('renders the header and the nine tabs in order', () => {
    renderAt('/settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'General',
      'Runtimes',
      'Roles',
      'People',
      'API Keys',
      'Credentials',
      'Cloud & devices',
      'Security',
      'System',
    ]);
  });

  it('shows General by default, with the panel linked to its tab', () => {
    renderAt('/settings');
    expect(screen.getByTestId('general-tab')).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-general');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });

  it.each([
    ['Runtimes', 'harness-tab', 'runtimes'],
    ['Roles', 'roles-tab', 'roles'],
    ['API Keys', 'api-keys-tab', 'api-keys'],
    ['Credentials', 'credentials-tab', 'credentials'],
    ['Cloud & devices', 'cloud-portal', 'cloud'],
    ['Security', 'security-overview', 'security'],
    ['System', 'system-tab', 'system'],
  ])('switches to %s and keeps it in ?tab=', (label, testId, id) => {
    renderAt('/settings');
    fireEvent.click(screen.getByRole('tab', { name: label }));
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByTestId('general-tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(`/settings?tab=${id}`);
  });

  it('drops ?tab= when going back to General', () => {
    renderAt('/settings?tab=system');
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings$/);
  });

  it.each([
    ['cloud', 'cloud-portal'],
    ['security', 'security-overview'],
    ['system', 'system-tab'],
    ['runtimes', 'harness-tab'],
    // Old id of the Runtimes tab
    ['harness', 'harness-tab'],
  ])('opens ?tab=%s', (tab, testId) => {
    renderAt(`/settings?tab=${tab}`);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it('keeps other query parameters for the moved-in pages (?tab=cloud&upgraded=true)', () => {
    renderAt('/settings?tab=cloud&upgraded=true');
    expect(screen.getByTestId('cloud-portal')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings?tab=cloud&upgraded=true');
  });

  it('defaults to General for an unknown tab', () => {
    renderAt('/settings?tab=nope');
    expect(screen.getByTestId('general-tab')).toBeInTheDocument();
  });
});

describe('Settings Page — tabs that moved out', () => {
  it('?tab=skills → Marketplace › Installed', () => {
    renderAt('/settings?tab=skills');
    expect(screen.getByTestId('where')).toHaveTextContent('/marketplace?tab=installed');
  });

  it('?tab=integrations → Connections, carrying the OAuth flags', () => {
    renderAt('/settings?tab=integrations&google=connected');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/connections\?google=connected$/);
  });

  it('?tab=slack (Cloud Slack install return) → the Slack card on Connections', () => {
    renderAt('/settings?tab=slack&slack=connected');
    expect(screen.getByTestId('where')).toHaveTextContent('/connections?slack=connected&platform=slack');
  });
});
