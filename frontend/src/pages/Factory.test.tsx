/**
 * Tests for Factory page.
 *
 * Tests the main factory visualization page with R3F FactoryScene.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Factory } from './Factory';

// Mock the useNavigate hook
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the SidebarContext
const mockCollapseSidebar = vi.fn();
const mockExpandSidebar = vi.fn();
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebar: () => ({
    isCollapsed: false,
    collapseSidebar: mockCollapseSidebar,
    expandSidebar: mockExpandSidebar,
    toggleSidebar: vi.fn(),
  }),
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
}));

// Mock FactoryScene component
vi.mock('@/components/Factory3D', () => ({
  FactoryScene: ({ showStats, className }: { showStats?: boolean; className?: string }) => (
    <div data-testid="factory-scene" data-show-stats={showStats} className={className}>
      Factory Scene Mock
    </div>
  ),
}));

const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>
    {children}
  </MemoryRouter>
);

describe('Factory Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the factory page', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      expect(screen.getByText('Back to Dashboard')).toBeInTheDocument();
    });

    it('should render the back button with arrow icon', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      expect(backButton).toBeInTheDocument();
      expect(screen.getByTestId('arrow-left-icon')).toBeInTheDocument();
    });

    it('should render the FactoryScene component', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const factoryScene = screen.getByTestId('factory-scene');
      expect(factoryScene).toBeInTheDocument();
      expect(factoryScene).toHaveClass('w-full', 'h-full');
    });

    it('should render the container with correct positioning classes', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const factoryScene = screen.getByTestId('factory-scene');
      const container = factoryScene.parentElement;
      expect(container).toHaveClass('fixed', 'inset-0', 'bg-background-dark');
    });
  });

  describe('Sidebar Management', () => {
    it('should collapse sidebar on mount', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      expect(mockCollapseSidebar).toHaveBeenCalledTimes(1);
    });

    it('should expand sidebar on unmount', () => {
      const { unmount } = render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      expect(mockExpandSidebar).not.toHaveBeenCalled();

      unmount();

      expect(mockExpandSidebar).toHaveBeenCalledTimes(1);
    });

    it('should not call expandSidebar while component is mounted', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      expect(mockExpandSidebar).not.toHaveBeenCalled();
    });
  });

  describe('Navigation', () => {
    it('should navigate to dashboard when back button is clicked', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      fireEvent.click(backButton);

      expect(mockNavigate).toHaveBeenCalledWith('/');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('should navigate to root path (dashboard)', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByText('Back to Dashboard');
      fireEvent.click(backButton);

      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  describe('Accessibility', () => {
    it('should have accessible back button', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button');
      expect(backButton).toBeInTheDocument();
      expect(backButton).toHaveTextContent('Back to Dashboard');
    });

    it('should support keyboard navigation for back button', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      backButton.focus();
      expect(document.activeElement).toBe(backButton);

      fireEvent.keyDown(backButton, { key: 'Enter', code: 'Enter' });
      // Click is triggered by Enter key on buttons
    });
  });

  describe('Styling', () => {
    it('should have hover styles on back button', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      // Library Button (secondary variant) owns the hover treatment now.
      expect(backButton).toHaveClass('bg-surface-dark', 'hover:bg-background-dark');
    });

    it('should have backdrop blur effect on back button', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      expect(backButton).toHaveClass('backdrop-blur-sm');
    });

    it('should have z-index on back button for layering', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      expect(backButton).toHaveClass('z-10');
    });
  });

  describe('Layout', () => {
    it('should position back button at top-left', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const backButton = screen.getByRole('button', { name: /back to dashboard/i });
      expect(backButton).toHaveClass('absolute', 'top-4', 'left-4');
    });

    it('should have responsive left margin for sidebar', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const factoryScene = screen.getByTestId('factory-scene');
      const container = factoryScene.parentElement;
      expect(container).toHaveClass('md:left-16');
    });
  });

  describe('Integration', () => {
    it('should properly integrate with sidebar context lifecycle', async () => {
      const { unmount, rerender } = render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      // Verify collapse called on initial mount
      expect(mockCollapseSidebar).toHaveBeenCalledTimes(1);

      // Re-render should not call collapse again (dependencies haven't changed)
      rerender(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );
      expect(mockCollapseSidebar).toHaveBeenCalledTimes(1);

      // Verify expand called on unmount
      unmount();
      expect(mockExpandSidebar).toHaveBeenCalledTimes(1);
    });

    it('should render FactoryScene with correct props', () => {
      render(
        <TestWrapper>
          <Factory />
        </TestWrapper>
      );

      const factoryScene = screen.getByTestId('factory-scene');
      expect(factoryScene).toHaveClass('w-full', 'h-full');
    });
  });
});
