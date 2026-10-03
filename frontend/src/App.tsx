import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/Layout/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { TeamDetail } from './pages/TeamDetail';
import { Assignments } from './pages/Assignments';
import { ScheduledCheckins } from './pages/ScheduledCheckins';
import { Triggers } from './pages/Triggers';
import { Factory } from './pages/Factory';
import { Settings } from './pages/Settings';
import { TeamChatRoute } from './components/Chat-team/TeamChatRoute';
import Connections from './pages/Connections';
import BrowserView from './pages/BrowserView';
import MarketplaceDetail from './pages/MarketplaceDetail';
import { Wiki } from './pages/Wiki';
import { Usage } from './pages/Usage';
import { TerminalProvider } from './contexts/TerminalContext';
import { SidebarProvider } from './contexts/SidebarContext';
import { AuthProvider } from './contexts/AuthContext';
import { PaymentWallProvider } from './contexts/PaymentWallContext';
import { AuthCallback } from './pages/AuthCallback';
import { Auth } from './pages/Auth';
import { Pricing } from './pages/Pricing';
import { MissionDetail } from './pages/MissionDetail';
import { WorkItemDetail } from './pages/WorkItemDetail';
import { RequestDetail } from './pages/RequestDetail';
import { ExperimentDetail } from './pages/ExperimentDetail';
import { TraceDetail } from './pages/TraceDetail';
import { TicketsHub } from './pages/hubs/TicketsHub';
import { TeamsHub } from './pages/hubs/TeamsHub';
import { MarketplaceHub } from './pages/hubs/MarketplaceHub';
import { LegacyRedirect } from './components/Routing/LegacyRedirect';
import { LEGACY_REDIRECTS } from './constants/routes.constants';
import { ApiTokenPrompt } from './components/ApiTokenPrompt/ApiTokenPrompt';
import { SetupRedirectGuard } from './components/Setup/SetupRedirectGuard';
import { Setup } from './pages/Setup';


function App() {
  return (
    <AuthProvider>
    <PaymentWallProvider>
    <TerminalProvider>
      <SidebarProvider>
        {/* Shown only when the backend challenges for the API token (non-loopback access). */}
        <ApiTokenPrompt />
        <Router>
          {/* First-run: send to /setup when the orc harness is missing / not installed / logged out. */}
          <SetupRedirectGuard />
          <Routes>
            {/* OAuth callback route (outside AppLayout — no sidebar/header) */}
            <Route path="/auth/callback" element={<AuthCallback />} />
            {/* Auth page (outside AppLayout — standalone login/register) */}
            <Route path="/auth" element={<Auth />} />
            {/* First-run harness setup (outside AppLayout — standalone, no sidebar) */}
            <Route path="/setup" element={<Setup />} />

            {/* Admin / Internal UI — routes: specs/2026-10-02-ui-redesign.md §Routes */}
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<Projects />} />
              <Route path="projects/:id" element={<ProjectDetail />} />
              {/* Teams: list + Goals tab (former Missions); goal detail under /teams/goals/:id */}
              <Route path="teams" element={<TeamsHub />} />
              <Route path="teams/goals/:id" element={<MissionDetail />} />
              <Route path="teams/:id" element={<TeamDetail />} />
              <Route path="assignments" element={<Assignments />} />
              <Route path="scheduled-checkins" element={<ScheduledCheckins />} />
              <Route path="triggers" element={<Triggers />} />
              <Route path="factory" element={<Factory />} />
              <Route path="connections" element={<Connections />} />
              <Route path="browser" element={<BrowserView />} />
              {/* Marketplace: Browse + Installed (former Settings › Skills) */}
              <Route path="marketplace" element={<MarketplaceHub />} />
              <Route path="marketplace/:id" element={<MarketplaceDetail />} />
              <Route path="wiki" element={<Wiki />} />
              <Route path="usage" element={<Usage />} />
              {/* Settings also hosts Cloud & devices (former /cloud) and Security (former /security) */}
              <Route path="settings" element={<Settings />} />
              <Route path="pricing" element={<Pricing />} />
              {/* Tickets: the home of all work — Board · Requests · Runs · Experiments, with their detail pages and run timelines */}
              <Route path="tickets" element={<TicketsHub />} />
              <Route path="tickets/requests/:id" element={<RequestDetail />} />
              <Route path="tickets/runs/:id" element={<WorkItemDetail />} />
              <Route path="tickets/experiments/:id" element={<ExperimentDetail />} />
              <Route path="tickets/traces/:traceId" element={<TraceDetail />} />

              {/*
                Team Chat: the single consolidated chat surface — a Slack-like
                3-panel shell wired live to chat-v2 via TeamChatRoute. Holds
                the orchestrator + agent DMs + team channels in one place.
                Deep-linkable from /teams via `?team=<id>`.
              */}
              <Route path="team-chat" element={<TeamChatRoute />} />

              {/* Old URLs (bookmarks, Slack links, decision cards) → their new home */}
              {LEGACY_REDIRECTS.map((rule) => (
                <Route key={rule.path} path={rule.path} element={<LegacyRedirect rule={rule} />} />
              ))}
            </Route>
          </Routes>
        </Router>
      </SidebarProvider>
    </TerminalProvider>
    </PaymentWallProvider>
    </AuthProvider>
  );
}

export default App;
