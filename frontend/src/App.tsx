import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/Layout/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Teams } from './pages/Teams';
import { TeamDetail } from './pages/TeamDetail';
import { Assignments } from './pages/Assignments';
import { ScheduledCheckins } from './pages/ScheduledCheckins';
import { Factory } from './pages/Factory';
import { Settings } from './pages/Settings';
import { Chat } from './pages/Chat';
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

            {/* Admin / Internal UI */}
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<Projects />} />
              <Route path="projects/:id" element={<ProjectDetail />} />
              <Route path="teams" element={<Teams />} />
              <Route path="teams/:id" element={<TeamDetail />} />
              <Route path="assignments" element={<Assignments />} />
              <Route path="scheduled-checkins" element={<ScheduledCheckins />} />
              <Route path="factory" element={<Factory />} />
              <Route path="marketplace" element={<Marketplace />} />
              <Route path="marketplace/:id" element={<MarketplaceDetail />} />
              <Route path="knowledge" element={<Knowledge />} />
              <Route path="security" element={<SecurityOverview />} />
              <Route path="monitoring/costs" element={<CostDashboard />} />
              <Route path="settings" element={<Settings />} />
              <Route path="pricing" element={<Pricing />} />
              <Route
                path="chat"
                element={
                  <ChatProvider>
                    <Chat />
                  </ChatProvider>
                }
              />
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
