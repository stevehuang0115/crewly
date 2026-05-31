/**
 * Navigation Component Tests
 *
 * Tests for the grouped sidebar navigation with 4 functional groups
 * (Work / Communicate / Tools / System), pinned favorites, and collapse behavior.
 *
 * @module components/Layout/Navigation.test
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { Navigation } from './Navigation';
import { SidebarProvider } from '../../contexts/SidebarContext';

// Mock the QRCodeDisplay component
vi.mock('./QRCodeDisplay', () => ({
  QRCodeDisplay: () => <div data-testid="qr-code">QR Code</div>,
}));

// Mock the AuthStatusIndicator component
vi.mock('../Auth/AuthStatusIndicator', () => ({
  AuthStatusIndicator: () => <div data-testid="auth-status">Auth Status</div>,
}));

// Mock usePinnedFavorites hook
const mockPinnedItems: Array<{ id: string; name: string; type: 'project' | 'team' }> = [];
vi.mock('../../hooks/usePinnedFavorites', () => ({
  usePinnedFavorites: () => ({
    pinnedItems: mockPinnedItems,
    isPinned: (id: string) => mockPinnedItems.some(p => p.id === id),
    togglePin: vi.fn(),
    isAtLimit: false,
  }),
  MAX_PINNED: 5,
  STORAGE_KEY: 'crewly_pinned_favorites',
}));

const renderWithProviders = (component: React.ReactElement) => {
  return render(
    <BrowserRouter>
      <SidebarProvider>
        {component}
      </SidebarProvider>
    </BrowserRouter>
  );
};

describe('Navigation', () => {
  beforeEach(() => {
    mockPinnedItems.length = 0;
  });

  // ---------------------------------------------------------------------------
  // 4-Group Navigation Structure
  // ---------------------------------------------------------------------------

  it('renders all 4 navigation group headers', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('nav-group-work')).toHaveTextContent('WORK');
    expect(screen.getByTestId('nav-group-communicate')).toHaveTextContent('COMMUNICATE');
    expect(screen.getByTestId('nav-group-tools')).toHaveTextContent('TOOLS');
    expect(screen.getByTestId('nav-group-system')).toHaveTextContent('SYSTEM');
  });

  it('renders Work group items: Dashboard, Projects, Teams', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /projects/i })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: /teams/i })).toHaveAttribute('href', '/teams');
  });

  it('renders Communicate group items: Chat (consolidated /team-chat)', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByRole('link', { name: /chat/i })).toHaveAttribute('href', '/team-chat');
  });

  it('no longer renders a separate Agents item (folded into Chat)', () => {
    renderWithProviders(<Navigation />);

    expect(screen.queryByRole('link', { name: /^agents$/i })).not.toBeInTheDocument();
  });

  it('renders Tools group items: Marketplace, Schedules', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByRole('link', { name: /marketplace/i })).toHaveAttribute('href', '/marketplace');
    expect(screen.getByRole('link', { name: /schedules/i })).toHaveAttribute('href', '/scheduled-checkins');
  });

  it('renders System group items: Security, Settings', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('href', '/security');
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings');
  });

  // ---------------------------------------------------------------------------
  // All Navigation Items
  // ---------------------------------------------------------------------------

  it('renders all 8 navigation items', () => {
    renderWithProviders(<Navigation />);

    const expectedItems = [
      'Dashboard', 'Projects', 'Teams', 'Chat',
      'Marketplace', 'Schedules', 'Security', 'Settings',
    ];
    expectedItems.forEach((item) => {
      expect(screen.getByText(item)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Logo and Branding
  // ---------------------------------------------------------------------------

  it('shows logo text when expanded', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByText('CREWLY')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Collapse / Expand
  // ---------------------------------------------------------------------------

  it('shows collapse toggle button in footer', () => {
    renderWithProviders(<Navigation />);

    const toggleButton = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(toggleButton).toBeInTheDocument();
  });

  it('toggles sidebar when footer button is clicked', () => {
    renderWithProviders(<Navigation />);

    const toggleButton = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(screen.getByText('Collapse')).toBeInTheDocument();

    fireEvent.click(toggleButton);

    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Mobile
  // ---------------------------------------------------------------------------

  it('renders close button when mobile menu is open', () => {
    const onMobileClose = vi.fn();
    renderWithProviders(<Navigation isMobileOpen={true} onMobileClose={onMobileClose} />);

    const closeButton = screen.getByRole('button', { name: /close menu/i });
    expect(closeButton).toBeInTheDocument();

    fireEvent.click(closeButton);
    expect(onMobileClose).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // QR Code and Auth
  // ---------------------------------------------------------------------------

  it('shows QR code display', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('qr-code')).toBeInTheDocument();
  });

  it('shows auth status indicator', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('auth-status')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Pinned Favorites
  // ---------------------------------------------------------------------------

  it('does not show pinned favorites section when empty', () => {
    renderWithProviders(<Navigation />);

    expect(screen.queryByTestId('pinned-favorites')).not.toBeInTheDocument();
  });

  it('shows pinned favorites when items exist', () => {
    mockPinnedItems.push(
      { id: 'proj-1', name: 'My Project', type: 'project' },
      { id: 'team-1', name: 'Dev Team', type: 'team' },
    );

    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('pinned-favorites')).toBeInTheDocument();
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(screen.getByText('My Project')).toBeInTheDocument();
    expect(screen.getByText('Dev Team')).toBeInTheDocument();
  });

  it('pinned project links to correct project URL', () => {
    mockPinnedItems.push(
      { id: 'proj-abc', name: 'Test Project', type: 'project' },
    );

    renderWithProviders(<Navigation />);

    const link = screen.getByRole('link', { name: /test project/i });
    expect(link).toHaveAttribute('href', '/projects/proj-abc');
  });

  it('pinned team links to correct team URL', () => {
    mockPinnedItems.push(
      { id: 'team-xyz', name: 'QA Team', type: 'team' },
    );

    renderWithProviders(<Navigation />);

    const link = screen.getByRole('link', { name: /qa team/i });
    expect(link).toHaveAttribute('href', '/teams/team-xyz');
  });
});
