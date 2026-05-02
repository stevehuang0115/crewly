import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AppLayout } from './components/Layout/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Teams } from './pages/Teams';
import { TeamDetail } from './pages/TeamDetail';
import { Assignments } from './pages/Assignments';
import { ScheduledCheckins } from './pages/ScheduledCheckins';
import { Triggers } from './pages/Triggers';
import { Factory } from './pages/Factory';
import { Settings } from './pages/Settings';
import { Chat } from './pages/Chat';
import TeamChatPage from './components/Chat-team';
import { Agents } from './pages/Agents';
import Marketplace from './pages/Marketplace';
import MarketplaceDetail from './pages/MarketplaceDetail';
import { Knowledge } from './pages/Knowledge';
import { SecurityOverview } from './pages/SecurityOverview';
import { CostDashboard } from './pages/CostDashboard';
import { TerminalProvider } from './contexts/TerminalContext';
import { SidebarProvider } from './contexts/SidebarContext';
import { ChatProvider } from './contexts/ChatContext';
import { AuthProvider } from './contexts/AuthContext';
import { PaymentWallProvider } from './contexts/PaymentWallContext';
import { AuthCallback } from './pages/AuthCallback';
import { Auth } from './pages/Auth';
import { Pricing } from './pages/Pricing';
import { CloudPortal } from './pages/CloudPortal';
import { Missions } from './pages/Missions';
import { MissionDetail } from './pages/MissionDetail';
import { WorkItems } from './pages/WorkItems';
import { RequestsPage } from './pages/RequestsPage';
import { RequestDetail } from './pages/RequestDetail';
import { OnboardingPreview } from './pages/OnboardingPreview';


/**
 * Redirect helper: maps `/requests/:id` → `/tasks/:id` while preserving
 * the request id so deep-links continue to resolve to the same detail
 * view after the route consolidation.
 *
 * @returns `<Navigate>` element pointing at the canonical V3 detail path
 */
function NavigateToTask() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/tasks/${id ?? ''}`} replace />;
}

function App() {
  return (
    <AuthProvider>
    <PaymentWallProvider>
    <TerminalProvider>
      <SidebarProvider>
        <Router>
          <Routes>
            {/* OAuth callback route (outside AppLayout — no sidebar/header) */}
            <Route path="/auth/callback" element={<AuthCallback />} />
            {/* Auth page (outside AppLayout — standalone login/register) */}
            <Route path="/auth" element={<Auth />} />
            {/*
              Onboarding V2.5 internal preview route — visual harness
              for F1/F2 (chat-thread shell + Blueprint sidebar) so Mia
              can review the W1 layout / empty-states / Progressive
              Reveal animation in a real browser without Storybook.
              Mounted OUTSIDE AppLayout so the preview takes the full
              viewport. Spec: docs/crewly-pro/68-onboarding-solution-spec-v2.md §12.2.
            */}
            <Route path="/onboarding-preview" element={<OnboardingPreview />} />

            {/* Admin / Internal UI */}
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<Projects />} />
              <Route path="projects/:id" element={<ProjectDetail />} />
              <Route path="teams" element={<Teams />} />
              <Route path="teams/:id" element={<TeamDetail />} />
              <Route path="assignments" element={<Assignments />} />
              <Route path="scheduled-checkins" element={<ScheduledCheckins />} />
              <Route path="triggers" element={<Triggers />} />
              <Route path="factory" element={<Factory />} />
              <Route path="marketplace" element={<Marketplace />} />
              <Route path="marketplace/:id" element={<MarketplaceDetail />} />
              <Route path="knowledge" element={<Knowledge />} />
              <Route path="security" element={<SecurityOverview />} />
              <Route path="monitoring/costs" element={<CostDashboard />} />
              <Route path="usage" element={<CostDashboard />} />
              <Route path="settings" element={<Settings />} />
              <Route path="pricing" element={<Pricing />} />
              <Route path="cloud" element={<CloudPortal />} />
              {/* V3 Request surface — `/tasks` is the canonical user-facing route per
                  PRD §3.1 ("Request List, Route: /tasks") and Ava's design report
                  (2026-04-05). The `/requests*` paths are kept as backward-compatible
                  redirects so any existing bookmarks / Slack permalinks land on the
                  same page. The legacy `TasksPage` (Intent Task surface) and its
                  `TaskTracking/*` component family were removed in this same
                  change set since nothing else mounted them. */}
              <Route path="tasks" element={<RequestsPage />} />
              <Route path="tasks/:id" element={<RequestDetail />} />
              <Route path="requests" element={<Navigate to="/tasks" replace />} />
              <Route path="requests/:id" element={<NavigateToTask />} />
              <Route path="missions" element={<Missions />} />
              <Route path="missions/:id" element={<MissionDetail />} />
              <Route path="workitems" element={<WorkItems />} />
              <Route path="workitems/:id" element={<WorkItems />} />

              <Route
                path="chat"
                element={
                  <ChatProvider>
                    <Chat />
                  </ChatProvider>
                }
              />

              {/*
                Team Chat: Phase B FE shell — Slack-like multi-team chat
                (Mia + Ava sealed design 2026-04-25). Mounts the additive
                @crewly/chat-ui surfaces (WorkspaceRail / ConversationListPanel
                / MentionComposer) in a 3-panel layout. Phase B is mock-only;
                Phase A backend wire lands once Sam ships the BE migration
                (target 2026-04-27 EOD).
              */}
              <Route path="team-chat" element={<TeamChatPage />} />

              {/*
                Agents: Phase 1 user↔agent direct chat (Sam tech spec
                2026-04-24). Mounts the shared `@crewly/chat-ui` package and
                talks to `/api/chat/channels/*`. Distinct from the
                orchestrator-pipe `/chat` above — see spec §1.
              */}
              <Route path="agents" element={<Agents />} />
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
