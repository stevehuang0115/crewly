// Layout standardization
// Dropdown update
// Updated: custom Dropdown component
// Updated: PageToolbar adoption
/**
 * Marketplace Page Tests
 *
 * Tests for the Marketplace page component including rendering,
 * filtering, search, sorting, and install/uninstall/update actions.
 *
 * @module pages/Marketplace.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Marketplace from './Marketplace';
import type { MarketplaceItemWithStatus } from '../types/marketplace.types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Store: () => <svg data-testid="store-icon" />,
  Search: () => <svg data-testid="search-icon" />,
  Download: () => <svg data-testid="download-icon" />,
  Star: () => <svg data-testid="star-icon" />,
  RefreshCw: () => <svg data-testid="refresh-icon" />,
  Package: () => <svg data-testid="package-icon" />,
  Check: () => <svg data-testid="check-icon" />,
  ArrowUp: () => <svg data-testid="arrow-up-icon" />,
  X: () => <svg data-testid="x-icon" />,
  Upload: () => <svg data-testid="upload-icon" />,
  Clock: () => <svg data-testid="clock-icon" />,
  CheckCircle: () => <svg data-testid="check-circle-icon" />,
  XCircle: () => <svg data-testid="x-circle-icon" />,
  Plug: () => <svg data-testid="plug-icon" />,
}));

// Mock marketplace service
const mockFetchItems = vi.fn();
const mockInstall = vi.fn();
const mockUninstall = vi.fn();
const mockUpdate = vi.fn();
const mockRefresh = vi.fn();

vi.mock('../services/marketplace.service', () => ({
  fetchMarketplaceItems: (...args: unknown[]) => mockFetchItems(...args),
  installMarketplaceItem: (...args: unknown[]) => mockInstall(...args),
  uninstallMarketplaceItem: (...args: unknown[]) => mockUninstall(...args),
  updateMarketplaceItem: (...args: unknown[]) => mockUpdate(...args),
  refreshMarketplaceRegistry: (...args: unknown[]) => mockRefresh(...args),
}));

/**
 * Create a mock marketplace item for testing.
 *
 * @param overrides - Partial overrides for the default mock item
 * @returns A complete MarketplaceItemWithStatus object
 */
function createMockItem(overrides: Partial<MarketplaceItemWithStatus> = {}): MarketplaceItemWithStatus {
  return {
    id: 'item-1',
    type: 'skill',
    name: 'Test Skill',
    description: 'A test skill for testing purposes',
    author: 'Test Author',
    version: '1.0.0',
    category: 'development',
    tags: ['test'],
    license: 'MIT',
    downloads: 1500,
    rating: 4.5,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-01T00:00:00Z',
    assets: {},
    installStatus: 'not_installed',
    ...overrides,
  };
}

const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>
    {children}
  </MemoryRouter>
);

describe('Marketplace Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchItems.mockResolvedValue([]);
  });

  describe('Rendering', () => {
    it('should render the marketplace page with header', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByText('Marketplace')).toBeInTheDocument();
      expect(screen.getByTestId('store-icon')).toBeInTheDocument();
    });

    it('should render the refresh button', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      const refreshButton = screen.getByRole('button', { name: /refresh marketplace/i });
      expect(refreshButton).toBeInTheDocument();
      expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();
    });

    it('should render filter tabs', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Skills' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: '3D Models' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Roles' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'MCP Tools' })).toBeInTheDocument();
    });

    it('should render search input', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
    });

    it('should render sort dropdown', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      const sortSelect = screen.getByRole('combobox', { name: /sort by/i });
      expect(sortSelect).toBeInTheDocument();
    });

    it('should show loading state initially', () => {
      mockFetchItems.mockReturnValue(new Promise(() => {})); // Never resolves

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByText('Loading marketplace...')).toBeInTheDocument();
    });

    it('should show empty state when no items found', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });
    });

    it('should show error state when fetch fails', async () => {
      mockFetchItems.mockRejectedValue(new Error('Network error'));

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Failed to load marketplace items')).toBeInTheDocument();
      });
    });
  });

  describe('Item Cards', () => {
    it('should render item cards when items are loaded', async () => {
      const items = [
        createMockItem({ id: 'item-1', name: 'Skill One' }),
        createMockItem({ id: 'item-2', name: 'Skill Two', type: 'model' }),
      ];
      mockFetchItems.mockResolvedValue(items);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Skill One')).toBeInTheDocument();
        expect(screen.getByText('Skill Two')).toBeInTheDocument();
      });
    });

    it('should display item type badge', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ type: 'skill' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('skill')).toBeInTheDocument();
      });
    });

    it('should display item version', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ version: '2.1.0' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('v2.1.0')).toBeInTheDocument();
      });
    });

    it('should display item author', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ author: 'Jane Doe' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('by Jane Doe')).toBeInTheDocument();
      });
    });

    it('should display formatted download count', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ downloads: 2500 })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('2.5k')).toBeInTheDocument();
      });
    });

    it('should display download count under 1000 as-is', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ downloads: 42 })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('42')).toBeInTheDocument();
      });
    });

    it('should display rating', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ rating: 4.5 })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('4.5')).toBeInTheDocument();
      });
    });

    it('should show check icon for installed items', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'installed' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('check-icon')).toBeInTheDocument();
      });
    });

    it('should show arrow-up icon for items with updates', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'update_available' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('arrow-up-icon').length).toBeGreaterThan(0);
      });
    });
  });

  describe('Install/Uninstall/Update Actions', () => {
    it('should show Install button for not_installed items', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'not_installed' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Install')).toBeInTheDocument();
      });
    });

    it('should show Uninstall button for installed items', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'installed' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Uninstall')).toBeInTheDocument();
      });
    });

    it('should show Update and Remove buttons for update_available items', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'update_available' })]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Update')).toBeInTheDocument();
        expect(screen.getByText('Remove')).toBeInTheDocument();
      });
    });

    it('should call installMarketplaceItem when Install is clicked', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-1', installStatus: 'not_installed' })]);
      mockInstall.mockResolvedValue({ success: true, message: 'Installed' });

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Install')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Install'));

      await waitFor(() => {
        expect(mockInstall).toHaveBeenCalledWith('item-1');
      });
    });

    it('should call uninstallMarketplaceItem when Uninstall is clicked', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-2', installStatus: 'installed' })]);
      mockUninstall.mockResolvedValue({ success: true, message: 'Uninstalled' });

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Uninstall')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Uninstall'));

      await waitFor(() => {
        expect(mockUninstall).toHaveBeenCalledWith('item-2');
      });
    });

    it('should call updateMarketplaceItem when Update is clicked', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-3', installStatus: 'update_available' })]);
      mockUpdate.mockResolvedValue({ success: true, message: 'Updated' });

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Update')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Update'));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('item-3');
      });
    });

    it('should reload items after install', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'not_installed' })]);
      mockInstall.mockResolvedValue({ success: true, message: 'Installed' });

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Install')).toBeInTheDocument();
      });

      // Clear call count from initial load
      mockFetchItems.mockClear();
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'installed' })]);

      fireEvent.click(screen.getByText('Install'));

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalled();
      });
    });
  });

  describe('Filtering', () => {
    it('should fetch items with type filter when tab is clicked', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      mockFetchItems.mockClear();

      fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'skill' })
        );
      });
    });

    it('should fetch items without type filter when All tab is clicked', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      // Click Skills first
      fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'skill' })
        );
      });

      mockFetchItems.mockClear();

      // Click All
      fireEvent.click(screen.getByRole('tab', { name: 'All' }));

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(
          expect.objectContaining({ type: undefined })
        );
      });
    });

    it('should fetch items with search query when search input changes', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      mockFetchItems.mockClear();

      const searchInput = screen.getByPlaceholderText('Search...');
      fireEvent.change(searchInput, { target: { value: 'robot' } });

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(
          expect.objectContaining({ search: 'robot' })
        );
      });
    });

    it('should fetch items with sort when sort dropdown changes', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      mockFetchItems.mockClear();

      const sortSelect = screen.getByRole('combobox', { name: /sort by/i });
      fireEvent.change(sortSelect, { target: { value: 'newest' } });

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(
          expect.objectContaining({ sort: 'newest' })
        );
      });
    });
  });

  describe('Refresh', () => {
    it('should call refreshMarketplaceRegistry when refresh button is clicked', async () => {
      mockFetchItems.mockResolvedValue([]);
      mockRefresh.mockResolvedValue(undefined);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /refresh marketplace/i }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('should reload items after refresh', async () => {
      mockFetchItems.mockResolvedValue([]);
      mockRefresh.mockResolvedValue(undefined);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      mockFetchItems.mockClear();

      fireEvent.click(screen.getByRole('button', { name: /refresh marketplace/i }));

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalled();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have accessible search input', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByRole('textbox', { name: /search marketplace/i })).toBeInTheDocument();
    });

    it('should have accessible sort select', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByRole('combobox', { name: /sort by/i })).toBeInTheDocument();
    });

    it('should have accessible tab list', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByRole('tablist', { name: /filter by type/i })).toBeInTheDocument();
    });

    it('should mark active tab as selected', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      const allTab = screen.getByRole('tab', { name: 'All' });
      expect(allTab).toHaveAttribute('aria-selected', 'true');

      const skillsTab = screen.getByRole('tab', { name: 'Skills' });
      expect(skillsTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should have loading status role', () => {
      mockFetchItems.mockReturnValue(new Promise(() => {}));

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('should have error alert role on error', async () => {
      mockFetchItems.mockRejectedValue(new Error('fail'));

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  describe('MCP Tools', () => {
    it('should fetch items with mcp_tool type when MCP Tools tab is clicked', async () => {
      mockFetchItems.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      mockFetchItems.mockClear();

      fireEvent.click(screen.getByRole('tab', { name: 'MCP Tools' }));

      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'mcp_tool' })
        );
      });
    });

    it('should render MCP tool cards with correct type badge', async () => {
      const mcpItem = createMockItem({
        id: 'mcp-filesystem',
        type: 'mcp_tool',
        name: 'Filesystem Server',
        description: 'Read and write files via MCP',
        author: 'Anthropic',
      });
      mockFetchItems.mockResolvedValue([mcpItem]);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Filesystem Server')).toBeInTheDocument();
        expect(screen.getByText('mcp_tool')).toBeInTheDocument();
        expect(screen.getByText('by Anthropic')).toBeInTheDocument();
      });
    });

    it('should support install/uninstall for MCP tool items', async () => {
      const mcpItem = createMockItem({
        id: 'mcp-github',
        type: 'mcp_tool',
        name: 'GitHub Server',
        installStatus: 'not_installed',
      });
      mockFetchItems.mockResolvedValue([mcpItem]);
      mockInstall.mockResolvedValue({ success: true, message: 'Installed GitHub Server' });

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Install')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Install'));

      await waitFor(() => {
        expect(mockInstall).toHaveBeenCalledWith('mcp-github');
      });
    });
  });

  describe('Toast Notifications', () => {
    it('should show success toast after successful install', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-1', installStatus: 'not_installed' })]);
      mockInstall.mockResolvedValue({ success: true, message: 'Installed Test Skill v1.0.0' });

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Install')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Install'));

      await waitFor(() => {
        expect(screen.getByText('Installed Test Skill v1.0.0')).toBeInTheDocument();
      });
    });

    it('should show error toast when install fails', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-1', installStatus: 'not_installed' })]);
      mockInstall.mockRejectedValue(new Error('Network error'));

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Install')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Install'));

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('should show error toast when uninstall fails', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-2', installStatus: 'installed' })]);
      mockUninstall.mockRejectedValue(new Error('Uninstall error'));

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Uninstall')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Uninstall'));

      await waitFor(() => {
        expect(screen.getByText('Uninstall error')).toBeInTheDocument();
      });
    });

    it('should show success toast after refresh', async () => {
      mockFetchItems.mockResolvedValue([]);
      mockRefresh.mockResolvedValue(undefined);

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /refresh marketplace/i }));

      await waitFor(() => {
        expect(screen.getByText('Registry refreshed')).toBeInTheDocument();
      });
    });

    it('should show error toast when refresh fails', async () => {
      mockFetchItems.mockResolvedValue([]);
      mockRefresh.mockRejectedValue(new Error('fail'));

      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No items found.')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /refresh marketplace/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed to refresh registry')).toBeInTheDocument();
      });
    });
  });
});
