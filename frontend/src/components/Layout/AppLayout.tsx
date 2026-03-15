import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Terminal, Menu, X } from 'lucide-react';
import { Navigation } from './Navigation';
import { TerminalPanel } from '../TerminalPanel/TerminalPanel';
import { OrchestratorStatusBanner } from '../OrchestratorStatusBanner';
import { UpdateBanner } from '../UpdateBanner';
import { CloudBar } from '../CloudBar';

import { SessionResumePopup } from '../SessionResumePopup';
import { TeamsRestorePopup } from '../TeamsRestorePopup';
import { useTerminal } from '../../contexts/TerminalContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { IconButton } from '../UI';
import clsx from 'clsx';

export const AppLayout: React.FC = () => {
  const { isTerminalOpen, openTerminal, closeTerminal } = useTerminal();
  const { isCollapsed } = useSidebar();
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleTerminal = () => {
    if (isTerminalOpen) {
      closeTerminal();
    } else {
      openTerminal();
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background-dark">
      {/* Session Resume Popup (shown once on app restart if previous sessions exist) */}
      <SessionResumePopup />

      {/* Teams Restore Popup (shown when teams data is missing but backup exists) */}
      <TeamsRestorePopup />

      {/* Mobile Backdrop */}
      <div
        className={`fixed inset-0 bg-black/60 z-40 md:hidden transition-opacity ${isMobileMenuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
      />

      {/* Sidebar - Mobile & Desktop */}
      <div className={clsx(
        'fixed left-0 top-0 h-full z-50 transition-all duration-300 ease-in-out',
        'md:translate-x-0',
        isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        isCollapsed ? 'md:w-16' : 'md:w-64',
        'w-64' // Always full width on mobile
      )}>
        <Navigation isMobileOpen={isMobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />
      </div>

      {/* Main Content Area */}
      <div className={clsx(
        "flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out",
        isCollapsed ? 'md:ml-16' : 'md:ml-64'
      )}>
        {/* Mobile Header */}
        <header className="md:hidden h-16 flex items-center justify-between px-4 bg-surface-dark/80 backdrop-blur-sm border-b border-border-dark sticky top-0 z-30">
          <IconButton
            variant="ghost"
            icon={isMobileMenuOpen ? X : Menu}
            onClick={() => setMobileMenuOpen(!isMobileMenuOpen)}
            aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMobileMenuOpen}
          />
          <h1 className="text-lg font-bold">Crewly</h1>
          <div className="w-10 h-10" /> {/* Spacer to center title */}
        </header>

        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <CloudBar />
          <UpdateBanner />
          <OrchestratorStatusBanner />
          <div className="flex-1 p-4 md:p-6 min-h-0 overflow-y-auto">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Terminal Toggle Button */}
      <IconButton
        className={`fixed bottom-6 right-6 z-40 ${isTerminalOpen ? 'bg-primary/90' : ''}`}
        icon={Terminal}
        onClick={toggleTerminal}
        variant="primary"
        aria-label={isTerminalOpen ? 'Close Terminal' : 'Open Terminal'}
      />

      {/* Terminal Side Panel with Overlay */}
      <>
        {isTerminalOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-30"
            onClick={closeTerminal}
          />
        )}
        <TerminalPanel
          isOpen={isTerminalOpen}
          onClose={closeTerminal}
        />
      </>
    </div>
  );
};