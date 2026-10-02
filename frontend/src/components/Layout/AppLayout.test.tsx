import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppLayout } from './AppLayout';
import { TerminalProvider } from '../../contexts/TerminalContext';
import { SidebarProvider } from '../../contexts/SidebarContext';

// Mock the child components
vi.mock('./Navigation', () => ({
  Navigation: () => <div data-testid="navigation">Navigation</div>,
}));

vi.mock('./MobileTabBar', () => ({
  MOBILE_TAB_BAR_HEIGHT: 64,
  MobileTabBar: () => <nav data-testid="mobile-tab-bar">Tabs</nav>,
}));

vi.mock('./NavBadges', () => ({
  NavBadgesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./AppStatusBar', () => ({
  AppStatusBar: () => <div data-testid="app-status-bar">Status</div>,
}));

vi.mock('../TerminalPanel/TerminalPanel', () => ({
  TerminalPanel: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="terminal-panel">Terminal Panel</div> : null
}));

vi.mock('../SessionResumePopup', () => ({
  SessionResumePopup: () => null
}));

vi.mock('../TeamsRestorePopup', () => ({
  TeamsRestorePopup: () => null
}));

// AppLayout reads payment-wall state; stub the hook so the test doesn't need
// the full PaymentWallProvider (and its API/auth dependencies).
vi.mock('../../contexts/PaymentWallContext', () => ({
  usePaymentWall: () => ({
    activeLimitEvent: null,
    escalationLevel: 'none',
    isVisible: false,
    dismiss: vi.fn(),
    openModal: vi.fn(),
  }),
}));

const renderWithProviders = (component: React.ReactElement) => {
  return render(
    <BrowserRouter>
      <TerminalProvider>
        <SidebarProvider>
          {component}
        </SidebarProvider>
      </TerminalProvider>
    </BrowserRouter>
  );
};

describe('AppLayout', () => {
  it('renders the sidebar (md and up only) and the phone tab bar', () => {
    renderWithProviders(<AppLayout />);

    expect(screen.getByTestId('navigation')).toBeInTheDocument();
    const sidebar = screen.getByTestId('sidebar-container');
    expect(sidebar.className).toContain('hidden');
    expect(sidebar.className).toContain('md:block');
    expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
  });

  it('has no hamburger menu or mobile header any more', () => {
    renderWithProviders(<AppLayout />);

    expect(screen.queryByRole('button', { name: /open menu/i })).not.toBeInTheDocument();
    expect(document.querySelector('header')).toBeNull();
  });

  it('renders the one system status bar inside the main content column, above the page', () => {
    renderWithProviders(<AppLayout />);

    const bar = screen.getByTestId('app-status-bar');
    const main = bar.closest('main');
    expect(main).not.toBeNull();
    expect(bar.compareDocumentPosition(screen.getByTestId('page-content')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offsets the content for the sidebar on desktop only', () => {
    renderWithProviders(<AppLayout />);

    const content = screen.getByTestId('page-content').closest('main')?.parentElement;
    expect(content?.className).toContain('md:ml-64');
    expect(content?.className).not.toMatch(/(?<!md:)(?<!\w)ml-\d/);
  });

  it('pads the page by the phone tab bar height so content is not hidden under it', () => {
    renderWithProviders(<AppLayout />);

    const spacer = screen.getByTestId('tab-bar-spacer');
    expect(spacer.className).toContain('md:hidden');
    expect(spacer.getAttribute('style')).toContain('64px');
  });

  it('renders terminal toggle button', () => {
    renderWithProviders(<AppLayout />);

    const toggleButton = screen.getByRole('button', { name: /terminal/i });
    expect(toggleButton).toBeInTheDocument();
    // Sits above the phone tab bar, at the usual corner from md up.
    expect(toggleButton.className).toContain('bottom-[88px]');
    expect(toggleButton.className).toContain('md:bottom-6');
  });

  it('hides the terminal toggle on the full-bleed chat route', () => {
    render(
      <MemoryRouter initialEntries={['/team-chat']}>
        <TerminalProvider>
          <SidebarProvider>
            <AppLayout />
          </SidebarProvider>
        </TerminalProvider>
      </MemoryRouter>,
    );
    // The fixed bottom-right terminal button overlaps the chat composer's
    // Send button, so it's hidden on /team-chat.
    expect(screen.queryByRole('button', { name: /open terminal/i })).not.toBeInTheDocument();
  });

  it('opens terminal panel when terminal button is clicked', () => {
    renderWithProviders(<AppLayout />);

    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();

    const toggleButton = screen.getByRole('button', { name: /open terminal/i });
    fireEvent.click(toggleButton);

    expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();
  });

  it('closes terminal panel when clicking close', () => {
    renderWithProviders(<AppLayout />);

    const openButton = screen.getByRole('button', { name: /open terminal/i });
    fireEvent.click(openButton);
    expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();

    const closeButton = screen.getByRole('button', { name: /close terminal/i });
    fireEvent.click(closeButton);

    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();
  });
});
