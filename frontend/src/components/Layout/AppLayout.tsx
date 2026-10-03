/**
 * App shell (specs/2026-10-02-ui-redesign.md §Navigation):
 * - md and up: the 12-item sidebar (`Navigation`), collapsible.
 * - phones: no sidebar and no hamburger; a bottom tab bar
 *   (`MobileTabBar`: Dashboard · Chat · Tickets · More).
 * - one system status line (`AppStatusBar`) above the page, shown only
 *   when something is wrong.
 *
 * @module components/Layout/AppLayout
 */
import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Terminal } from 'lucide-react';
import { Navigation } from './Navigation';
import { MobileTabBar, MOBILE_TAB_BAR_HEIGHT } from './MobileTabBar';
import { NavBadgesProvider } from './NavBadges';
import { AppStatusBar } from './AppStatusBar';
import { TerminalPanel } from '../TerminalPanel/TerminalPanel';

import { SessionResumePopup } from '../SessionResumePopup';
import { TeamsRestorePopup } from '../TeamsRestorePopup';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { useTerminal } from '../../contexts/TerminalContext';
import { useSidebar } from '../../contexts/SidebarContext';
import { IconButton } from '@crewly/ui';
import { PaymentWallModal } from '../PaymentWall/PaymentWall';
import { usePaymentWall } from '../../contexts/PaymentWallContext';
import { apiService } from '../../services/api.service';
import type { BillingInterval } from '../../types/payment-wall.types';
import clsx from 'clsx';

export const AppLayout: React.FC = () => {
  const { isTerminalOpen, openTerminal, closeTerminal } = useTerminal();
  const { isCollapsed } = useSidebar();
  const { activeLimitEvent, escalationLevel, isVisible, dismiss } = usePaymentWall();
  const location = useLocation();

  // Full-bleed routes manage their own internal padding + scrolling (e.g. the
  // 3-panel team chat). For those we drop the content-area padding and outer
  // scroll so they fill the viewport edge-to-edge with no dead strips.
  const isFullBleed = location.pathname.startsWith('/team-chat');

  const toggleTerminal = () => {
    if (isTerminalOpen) {
      closeTerminal();
    } else {
      openTerminal();
    }
  };

  return (
    <NavBadgesProvider>
    <div className="flex h-screen overflow-hidden bg-bg">
      {/* Session Resume Popup (shown once on app restart if previous sessions exist) */}
      <SessionResumePopup />

      {/* Teams Restore Popup (shown when teams data is missing but backup exists) */}
      <TeamsRestorePopup />

      {/* Crewly was updated under this tab: ask to reload (#1010 review) */}
      <UpdateAvailableBanner />

      {/* Sidebar — md and up only; phones use the bottom tab bar */}
      <div
        className={clsx(
          'hidden md:block fixed left-0 top-0 h-full z-50 transition-all duration-300 ease-in-out',
          isCollapsed ? 'md:w-16' : 'md:w-64'
        )}
        data-testid="sidebar-container"
      >
        <Navigation />
      </div>

      {/* Main Content Area */}
      <div className={clsx(
        "flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out",
        isCollapsed ? 'md:ml-16' : 'md:ml-64'
      )}>
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* One status line (orchestrator / sign-in / runtime usage / update) — in the content column, never under the sidebar. */}
          <AppStatusBar />
          <div
            className={clsx(
              'flex-1 min-h-0',
              isFullBleed ? 'overflow-hidden' : 'p-4 md:p-6 overflow-y-auto'
            )}
            data-testid="page-content"
          >
            <Outlet />
          </div>
          {/* Phone: keep the page clear of the fixed tab bar */}
          <div
            className="md:hidden shrink-0"
            data-testid="tab-bar-spacer"
            style={{ height: `calc(${MOBILE_TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))` }}
            aria-hidden="true"
          />
        </main>
      </div>

      {/* Phone navigation */}
      <MobileTabBar />

      {/* Terminal Toggle Button — hidden on full-bleed routes (the chat),
          where its fixed bottom-right position overlaps the composer's Send
          button. */}
      {!isFullBleed && (
        <IconButton
          className={`fixed bottom-[88px] right-4 md:bottom-6 md:right-6 z-40 ${isTerminalOpen ? 'bg-primary/90' : ''}`}
          icon={Terminal}
          onClick={toggleTerminal}
          variant="primary"
          title={isTerminalOpen ? 'Close Terminal' : 'Open Terminal'}
          aria-label={isTerminalOpen ? 'Close Terminal' : 'Open Terminal'}
        />
      )}

      {/* Terminal Side Panel with Overlay */}
      <>
        {isTerminalOpen && (
          <div
            className="fixed inset-0 bg-background-dark/60 z-30"
            onClick={closeTerminal}
          />
        )}
        <TerminalPanel
          isOpen={isTerminalOpen}
          onClose={closeTerminal}
        />
      </>

      {/* Payment Wall Modal — rendered once at root level */}
      {activeLimitEvent && isVisible && escalationLevel === 'modal' && (
        <PaymentWallModal
          isOpen={true}
          event={activeLimitEvent}
          onClose={dismiss}
          onUpgrade={async (interval: BillingInterval) => {
            try {
              const stripeInterval = interval === 'monthly' ? 'month' : 'year';
              const result = await apiService.createCheckoutSession(
                'pro',
                stripeInterval as 'month' | 'year',
                `${window.location.origin}/settings?tab=cloud&upgraded=true`,
                window.location.href,
              );
              window.location.href = result.checkoutUrl;
            } catch {
              // Checkout creation failed — modal stays open for retry
            }
          }}
        />
      )}
    </div>
    </NavBadgesProvider>
  );
};
