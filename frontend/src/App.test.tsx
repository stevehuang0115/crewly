/**
 * App route tests — includes RequestDetail route at /requests/:id.
 *
 * @vitest-environment jsdom
 * @module App.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
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
vi.mock('./pages/Chat', () => ({ Chat: () => <div>Chat Page</div> }));
vi.mock('./pages/Marketplace', () => ({ default: () => <div>Marketplace Page</div> }));
vi.mock('./pages/MarketplaceDetail', () => ({ default: () => <div>Marketplace Detail Page</div> }));
vi.mock('./pages/Knowledge', () => ({ Knowledge: () => <div>Knowledge Page</div> }));
vi.mock('./pages/SecurityOverview', () => ({ SecurityOverview: () => <div>Security Page</div> }));
vi.mock('./pages/CostDashboard', () => ({ CostDashboard: () => <div>Cost Dashboard Page</div> }));
vi.mock('./pages/AuthCallback', () => ({ AuthCallback: () => <div>Auth Callback Page</div> }));
vi.mock('./pages/Auth', () => ({ Auth: () => <div>Auth Page</div> }));
vi.mock('./pages/Pricing', () => ({ Pricing: () => <div>Pricing Page</div> }));
vi.mock('./pages/CloudPortal', () => ({ CloudPortal: () => <div>Cloud Portal Page</div> }));
vi.mock('./pages/RequestsPage', () => ({ RequestsPage: () => <div>Requests Page</div> }));
vi.mock('./pages/WorkItems', () => ({ WorkItems: () => <div>WorkItems Page</div> }));
vi.mock('./pages/WorkItemDetail', () => ({ WorkItemDetail: () => <div>WorkItem Detail Page</div> }));
vi.mock('./pages/Missions', () => ({ Missions: () => <div>Missions Page</div> }));

// Phase B Slack-like multi-team chat — mounted at /team-chat.
vi.mock('./components/Chat-team', () => ({
  default: () => <div data-testid="team-chat-route">Team Chat Page</div>,
}));

describe('App routes', () => {
  it('redirects /schedules to the scheduled check-ins page', async () => {
    window.history.pushState({}, '', '/schedules');

    render(<App />);

    expect(await screen.findByText('Schedules & Cron Page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/scheduled-checkins');
  });

  it('mounts TeamChatPage at /team-chat', async () => {
    window.history.pushState({}, '', '/team-chat');

    render(<App />);

    expect(await screen.findByTestId('team-chat-route')).toBeInTheDocument();
  });
});
