import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppLayout } from './AppLayout';
import { TerminalProvider } from '../../contexts/TerminalContext';
import { SidebarProvider } from '../../contexts/SidebarContext';

// Mock the child components
vi.mock('./Navigation', () => ({
  Navigation: ({ isMobileOpen, onMobileClose }: { isMobileOpen?: boolean; onMobileClose?: () => void }) => (
    <div data-testid="navigation" data-mobile-open={isMobileOpen}>
      Navigation
      {onMobileClose && <button onClick={onMobileClose} data-testid="nav-close">Close Nav</button>}
    </div>
  )
}));

vi.mock('../TerminalPanel/TerminalPanel', () => ({
  TerminalPanel: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="terminal-panel">Terminal Panel</div> : null
}));

vi.mock('../OrchestratorStatusBanner', () => ({
  OrchestratorStatusBanner: () => <div data-testid="orchestrator-banner">Orchestrator Banner</div>
}));

vi.mock('../UpdateBanner', () => ({
  UpdateBanner: () => null
}));

vi.mock('../SessionResumePopup', () => ({
  SessionResumePopup: () => null
}));

vi.mock('../TeamsRestorePopup', () => ({
  TeamsRestorePopup: () => null
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
  it('renders navigation and orchestrator banner', () => {
    renderWithProviders(<AppLayout />);

    expect(screen.getByTestId('navigation')).toBeInTheDocument();
    expect(screen.getByTestId('orchestrator-banner')).toBeInTheDocument();
  });

  it('renders terminal toggle button', () => {
    renderWithProviders(<AppLayout />);

    const toggleButton = screen.getByRole('button', { name: /terminal/i });
    expect(toggleButton).toBeInTheDocument();
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

  describe('Mobile sidebar behavior', () => {
    it('renders mobile header with hamburger menu button', () => {
      renderWithProviders(<AppLayout />);

      const menuButton = screen.getByRole('button', { name: /open menu/i });
      expect(menuButton).toBeInTheDocument();
    });

    it('shows Crewly title in mobile header', () => {
      renderWithProviders(<AppLayout />);

      expect(screen.getByText('Crewly')).toBeInTheDocument();
    });

    it('sidebar starts with mobile-hidden state (translate off-screen)', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const sidebar = container.querySelector('.fixed.left-0.top-0');
      expect(sidebar).toBeInTheDocument();
      expect(sidebar?.className).toContain('-translate-x-full');
      expect(sidebar?.className).not.toContain(' translate-x-0');
    });

    it('sidebar becomes visible when hamburger menu is clicked', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const menuButton = screen.getByRole('button', { name: /open menu/i });
      fireEvent.click(menuButton);

      const sidebar = container.querySelector('.fixed.left-0.top-0');
      expect(sidebar?.className).toContain('translate-x-0');
      expect(sidebar?.className).not.toContain('-translate-x-full');
    });

    it('passes isMobileOpen=true to Navigation when menu is open', () => {
      renderWithProviders(<AppLayout />);

      const menuButton = screen.getByRole('button', { name: /open menu/i });
      fireEvent.click(menuButton);

      const nav = screen.getByTestId('navigation');
      expect(nav).toHaveAttribute('data-mobile-open', 'true');
    });

    it('passes isMobileOpen=false to Navigation when menu is closed', () => {
      renderWithProviders(<AppLayout />);

      const nav = screen.getByTestId('navigation');
      expect(nav).toHaveAttribute('data-mobile-open', 'false');
    });

    it('closes sidebar when backdrop overlay is clicked', () => {
      const { container } = renderWithProviders(<AppLayout />);

      // Open sidebar
      const menuButton = screen.getByRole('button', { name: /open menu/i });
      fireEvent.click(menuButton);

      // Click backdrop
      const backdrop = container.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);

      // Sidebar should be hidden
      const sidebar = container.querySelector('.fixed.left-0.top-0');
      expect(sidebar?.className).toContain('-translate-x-full');
    });

    it('backdrop is invisible when sidebar is closed', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const backdrop = container.querySelector('[aria-hidden="true"]');
      expect(backdrop?.className).toContain('opacity-0');
      expect(backdrop?.className).toContain('pointer-events-none');
    });

    it('backdrop is visible when sidebar is open', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const menuButton = screen.getByRole('button', { name: /open menu/i });
      fireEvent.click(menuButton);

      const backdrop = container.querySelector('[aria-hidden="true"]');
      expect(backdrop?.className).toContain('opacity-100');
      expect(backdrop?.className).not.toContain('pointer-events-none');
    });

    it('closes sidebar when Navigation onMobileClose is triggered', () => {
      const { container } = renderWithProviders(<AppLayout />);

      // Open sidebar
      const menuButton = screen.getByRole('button', { name: /open menu/i });
      fireEvent.click(menuButton);

      // Use Navigation's close callback
      const navClose = screen.getByTestId('nav-close');
      fireEvent.click(navClose);

      // Sidebar should be hidden
      const sidebar = container.querySelector('.fixed.left-0.top-0');
      expect(sidebar?.className).toContain('-translate-x-full');
    });

    it('hamburger button has aria-expanded attribute', () => {
      renderWithProviders(<AppLayout />);

      const menuButton = screen.getByRole('button', { name: /open menu/i });
      expect(menuButton).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(menuButton);

      const closeButton = screen.getByRole('button', { name: /close menu/i });
      expect(closeButton).toHaveAttribute('aria-expanded', 'true');
    });

    it('sidebar has correct z-index for overlay behavior', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const sidebar = container.querySelector('.fixed.left-0.top-0');
      expect(sidebar?.className).toContain('z-50');
    });

    it('sidebar uses md:translate-x-0 for desktop always-visible behavior', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const sidebar = container.querySelector('.fixed.left-0.top-0');
      expect(sidebar?.className).toContain('md:translate-x-0');
    });

    it('main content has no left margin on mobile (only md: margin)', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const mainContent = container.querySelector('.flex-1.flex.flex-col.min-w-0');
      expect(mainContent?.className).toContain('md:ml-64');
      expect(mainContent?.className).not.toMatch(/(?<!md:)(?<!\w)ml-\d/);
    });

    it('mobile header is hidden on desktop via md:hidden class', () => {
      const { container } = renderWithProviders(<AppLayout />);

      const mobileHeader = container.querySelector('header');
      expect(mobileHeader?.className).toContain('md:hidden');
    });
  });
});
