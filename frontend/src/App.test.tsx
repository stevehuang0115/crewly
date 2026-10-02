/**
 * App route tests — the redesigned routes and every old-URL redirect
 * (specs/2026-10-02-ui-redesign.md §Routes).
 *
 * @vitest-environment jsdom
 * @module App.test
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { Outlet } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./components/Layout/AppLayout', () => ({
  AppLayout: () => <Outlet />,
}));

vi.mock('./pages/Dashboard', () => ({ Dashboard: () => <div>Dashboard Page</div> }));
vi.mock('./pages/Projects', () => ({ Projects: () => <div>Projects Page</div> }));
vi.mock('./pages/ProjectDetail', () => ({ ProjectDetail: () => <div>Project Detail Page</div> }));
vi.mock('./pages/Teams', () => ({ Teams: () => <div>Teams Page</div> }));
vi.mock('./pages/TeamDetail', () => ({ TeamDetail: () => <div>Team Detail Page</div> }));
vi.mock('./pages/Assignments', () => ({ Assignments: () => <div>Assignments Page</div> }));
vi.mock('./pages/ScheduledCheckins', () => ({ ScheduledCheckins: () => <div>Schedules & Cron Page</div> }));
vi.mock('./pages/Factory', () => ({ Factory: () => <div>Factory Page</div> }));
vi.mock('./pages/Settings', () => ({ Settings: () => <div>Settings Page</div> }));
vi.mock('./pages/Marketplace', () => ({ default: () => <div>Marketplace Page</div> }));
vi.mock('./pages/MarketplaceDetail', () => ({ default: () => <div>Marketplace Detail Page</div> }));
vi.mock('./pages/Usage', () => ({ Usage: () => <div>Usage Page</div> }));
vi.mock('./pages/AuthCallback', () => ({ AuthCallback: () => <div>Auth Callback Page</div> }));
vi.mock('./pages/Auth', () => ({ Auth: () => <div>Auth Page</div> }));
vi.mock('./pages/Pricing', () => ({ Pricing: () => <div>Pricing Page</div> }));
vi.mock('./pages/RequestsPage', () => ({ RequestsPage: () => <div>Requests Page</div> }));
vi.mock('./pages/WorkItems', () => ({ WorkItems: () => <div>WorkItems Page</div> }));
vi.mock('./pages/WorkItemDetail', () => ({ WorkItemDetail: () => <div>WorkItem Detail Page</div> }));
vi.mock('./pages/Missions', () => ({ Missions: () => <div>Missions Page</div> }));
vi.mock('./pages/MissionDetail', () => ({ MissionDetail: () => <div>Mission Detail Page</div> }));
vi.mock('./pages/Tickets', () => ({ Tickets: () => <div>Tickets Page</div> }));
vi.mock('./pages/RequestDetail', () => ({ RequestDetail: () => <div>Request Detail Page</div> }));
vi.mock('./components/Marketplace/InstalledSkills', () => ({ InstalledSkills: () => <div>Installed Skills Panel</div> }));


// Consolidated multi-team chat — mounted live at /team-chat via TeamChatRoute.
vi.mock('./components/Chat-team/TeamChatRoute', () => ({
  TeamChatRoute: () => <div data-testid="team-chat-route">Team Chat Page</div>,
}));

describe('App routes', () => {
  it('redirects /schedules to the scheduled check-ins page', async () => {
    window.history.pushState({}, '', '/schedules');

    render(<App />);

    expect(await screen.findByText('Schedules & Cron Page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/scheduled-checkins');
  });

  it('mounts the live TeamChatRoute at /team-chat', async () => {
    window.history.pushState({}, '', '/team-chat');

    render(<App />);

    expect(await screen.findByTestId('team-chat-route')).toBeInTheDocument();
  });

  it('redirects the former /chat to the consolidated /team-chat', async () => {
    window.history.pushState({}, '', '/chat');

    render(<App />);

    expect(await screen.findByTestId('team-chat-route')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/team-chat');
  });

  it('redirects the former /agents to the consolidated /team-chat', async () => {
    window.history.pushState({}, '', '/agents');

    render(<App />);

    expect(await screen.findByTestId('team-chat-route')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/team-chat');
  });

  it('mounts the ticket board at /tickets', async () => {
    window.history.pushState({}, '', '/tickets');

    render(<App />);

    expect(await screen.findByText('Tickets Page')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
  });

  it.each([
    ['/tickets?tab=requests', 'Requests Page'],
    ['/tickets?tab=runs', 'WorkItems Page'],
    ['/teams', 'Teams Page'],
    ['/teams?tab=goals', 'Missions Page'],
    ['/marketplace', 'Marketplace Page'],
    ['/marketplace?tab=installed', 'Installed Skills Panel'],
    ['/tickets/requests/req-1', 'Request Detail Page'],
    ['/tickets/runs/abc-123', 'WorkItem Detail Page'],
    ['/teams/goals/m-1', 'Mission Detail Page'],
    ['/teams/team-1', 'Team Detail Page'],
    ['/usage', 'Usage Page'],
  ])('mounts %s', async (url, text) => {
    window.history.pushState({}, '', url);

    render(<App />);

    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});

describe('App — old URLs redirect to their new home', () => {
  it.each([
    ['/tasks', '/tickets', '?tab=requests', 'Requests Page'],
    ['/requests', '/tickets', '?tab=requests', 'Requests Page'],
    ['/tasks/req-7', '/tickets/requests/req-7', '', 'Request Detail Page'],
    ['/requests/req-7', '/tickets/requests/req-7', '', 'Request Detail Page'],
    ['/workitems', '/tickets', '?tab=runs', 'WorkItems Page'],
    ['/workitems/abc-123', '/tickets/runs/abc-123', '', 'WorkItem Detail Page'],
    ['/missions', '/teams', '?tab=goals', 'Missions Page'],
    ['/missions/m-9', '/teams/goals/m-9', '', 'Mission Detail Page'],
    ['/cloud', '/settings', '?tab=cloud', 'Settings Page'],
    ['/security', '/settings', '?tab=security', 'Settings Page'],
    ['/monitoring/costs', '/usage', '', 'Usage Page'],
  ])('%s → %s%s', async (from, pathname, search, text) => {
    window.history.pushState({}, '', from);

    render(<App />);

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.search).toBe(search);
  });

  it('keeps the old query string and hash (e.g. /cloud?upgraded=true)', async () => {
    window.history.pushState({}, '', '/cloud?upgraded=true#plan');

    render(<App />);

    expect(await screen.findByText('Settings Page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('cloud');
    expect(new URLSearchParams(window.location.search).get('upgraded')).toBe('true');
    expect(window.location.hash).toBe('#plan');
  });

  it('lets the new tab win over an old ?tab= value', async () => {
    window.history.pushState({}, '', '/workitems?tab=x&status=failed');

    render(<App />);

    expect(await screen.findByText('WorkItems Page')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('runs');
    expect(new URLSearchParams(window.location.search).get('status')).toBe('failed');
  });
});

describe('App token prompt', () => {
  it('shows the API token prompt when a token challenge is raised', async () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.queryByTestId('api-token-prompt')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent('crewly:api-token-required'));
    });
    expect(await screen.findByTestId('api-token-prompt')).toBeInTheDocument();
  });
});

// First-run setup: the page and the redirect guard are covered in
// Setup.test.tsx / SetupRedirectGuard.test.tsx; here we only check wiring.
vi.mock('./pages/Setup', () => ({ Setup: () => <div>Setup Page</div> }));
vi.mock('./components/Setup/SetupRedirectGuard', () => ({
  SetupRedirectGuard: () => <div data-testid="setup-redirect-guard-mock" />,
}));

describe('App first-run setup', () => {
  it('mounts the standalone Setup page at /setup', async () => {
    window.history.pushState({}, '', '/setup');
    render(<App />);
    expect(await screen.findByText('Setup Page')).toBeInTheDocument();
  });

  it('mounts the setup redirect guard inside the router', async () => {
    window.history.pushState({}, '', '/tickets');
    render(<App />);
    expect(await screen.findByTestId('setup-redirect-guard-mock')).toBeInTheDocument();
  });
});
