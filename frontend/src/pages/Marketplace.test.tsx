// Design token migration
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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Marketplace from './Marketplace';
import type { MarketplaceItemWithStatus } from '../types/marketplace.types';

// Mock lucide-react icons
// Partial mock: keep every real icon (library components such as Dropdown
// import their own), and stub the ones these tests look up by test id.
vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lucide-react')>()),
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
const mockFetchSubmissions = vi.fn();
const mockReview = vi.fn();

vi.mock('../services/marketplace.service', () => ({
  fetchMarketplaceItems: (...args: unknown[]) => mockFetchItems(...args),
  installMarketplaceItem: (...args: unknown[]) => mockInstall(...args),
  uninstallMarketplaceItem: (...args: unknown[]) => mockUninstall(...args),
  updateMarketplaceItem: (...args: unknown[]) => mockUpdate(...args),
  refreshMarketplaceRegistry: (...args: unknown[]) => mockRefresh(...args),
  fetchSubmissions: (...args: unknown[]) => mockFetchSubmissions(...args),
  reviewMarketplaceSubmission: (...args: unknown[]) => mockReview(...args),
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
    it('should render the Browse panel (the hub owns the page header)', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByTestId('marketplace-browse')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('No items found.')).toBeInTheDocument());
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

    it('should keep every type behind the Filter button', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );
      fireEvent.click(screen.getByTestId('filter-button'));
      for (const label of ['Skills', '3D Models', 'Roles', 'MCP Tools', 'Connectors']) {
        expect(screen.getByLabelText(label)).toBeInTheDocument();
      }
    });

    it('should render search input', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
    });

    it('should keep sort behind the Filter button', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );
      fireEvent.click(screen.getByTestId('filter-button'));
      expect(screen.getByLabelText('Popular')).toBeInTheDocument();
      expect(screen.getByLabelText('Highest Rated')).toBeInTheDocument();
      expect(screen.getByLabelText('Newest')).toBeInTheDocument();
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

    it('should display the item type in the meta line', async () => {
      mockFetchItems.mockResolvedValue([createMockItem()]);
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('Skill')).toBeInTheDocument());
    });

    it('should leave the version to the detail page', async () => {
      mockFetchItems.mockResolvedValue([createMockItem()]);
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('Test Skill')).toBeInTheDocument());
      expect(screen.queryByText('v1.0.0')).not.toBeInTheDocument();
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

    it('should leave download counts to the detail page', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ downloads: 1500 })]);
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('Test Skill')).toBeInTheDocument());
      expect(screen.queryByText('1.5k')).not.toBeInTheDocument();
    });

    it('should open the detail page when a row is clicked', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ id: 'item-1' })]);
      render(
        <MemoryRouter initialEntries={['/marketplace']}>
          <Routes>
            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/marketplace/:id" element={<div>Detail page</div>} />
          </Routes>
        </MemoryRouter>
      );
      fireEvent.click(await screen.findByText('Test Skill'));
      expect(await screen.findByText('Detail page')).toBeInTheDocument();
    });

    it('should offer View details behind the row menu', async () => {
      mockFetchItems.mockResolvedValue([createMockItem()]);
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      fireEvent.click(await screen.findByRole('button', { name: 'More actions for Test Skill' }));
      expect(screen.getByRole('menuitem', { name: /View details/ })).toBeInTheDocument();
    });

    it('should say Installed for installed items', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({ installStatus: 'installed' })]);
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('Installed')).toBeInTheDocument());
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
    it('should fetch items with type filter when a type is picked', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('No items found.')).toBeInTheDocument());
      mockFetchItems.mockClear();
      fireEvent.click(screen.getByTestId('filter-button'));
      fireEvent.click(screen.getByLabelText('Skills'));
      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(expect.objectContaining({ type: 'skill' }));
      });
      expect(screen.getByText('Type: Skills')).toBeInTheDocument();
    });

    it('should fetch items without type filter when the type chip is removed', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('No items found.')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('filter-button'));
      fireEvent.click(screen.getByLabelText('Roles'));
      await waitFor(() => expect(mockFetchItems).toHaveBeenCalledWith(expect.objectContaining({ type: 'role' })));
      mockFetchItems.mockClear();
      fireEvent.click(screen.getByLabelText('Roles'));
      await waitFor(() => expect(mockFetchItems).toHaveBeenCalledWith(expect.objectContaining({ type: undefined })));
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

    it('should fetch items with sort when a sort is picked', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('No items found.')).toBeInTheDocument());
      mockFetchItems.mockClear();
      fireEvent.click(screen.getByTestId('filter-button'));
      fireEvent.click(screen.getByLabelText('Newest'));
      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(expect.objectContaining({ sort: 'newest' }));
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

    it('should have an accessible Filter button', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      expect(screen.getByTestId('filter-button')).toHaveAttribute('aria-haspopup', 'dialog');
    });

    it('should list connectors under the Connectors type, linking to Connections', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );
      fireEvent.click(screen.getByTestId('filter-button'));
      fireEvent.click(screen.getByLabelText('Connectors'));
      expect(screen.getByTestId('marketplace-connectors')).toBeInTheDocument();
      expect(screen.getByTestId('marketplace-connector-slack')).toBeInTheDocument();
      const connect = screen.getAllByRole('link', { name: 'Connect →' })[0];
      expect(connect).toHaveAttribute('href', '/connections?platform=slack');
    });

    it('should show the active filter as a removable chip', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );
      fireEvent.click(screen.getByTestId('filter-button'));
      fireEvent.click(screen.getByLabelText('3D Models'));
      expect(screen.getByText('Type: 3D Models')).toBeInTheDocument();
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
    it('should fetch items with mcp_tool type when MCP Tools is picked', async () => {
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => expect(screen.getByText('No items found.')).toBeInTheDocument());
      mockFetchItems.mockClear();
      fireEvent.click(screen.getByTestId('filter-button'));
      fireEvent.click(screen.getByLabelText('MCP Tools'));
      await waitFor(() => {
        expect(mockFetchItems).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp_tool' }));
      });
    });

    it('should render MCP tool rows with their type and author', async () => {
      mockFetchItems.mockResolvedValue([createMockItem({
        id: 'mcp-filesystem',
        type: 'mcp_tool',
        name: 'Filesystem Server',
        description: 'Read and write files via MCP',
        author: 'Anthropic',
      })]);
      render(
        <TestWrapper>
          <Marketplace />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Filesystem Server')).toBeInTheDocument();
        expect(screen.getByText('MCP Tool')).toBeInTheDocument();
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

  describe('Submissions', () => {
    const pending = {
      id: 'sub-1',
      skillId: 'transcribe-audio',
      name: 'transcribe-audio',
      description: 'Transcribe audio to text with Whisper.',
      author: 'Crewly Team',
      version: '1.0.0',
      category: 'content',
      tags: [],
      license: 'MIT',
      status: 'pending' as const,
      archivePath: '/tmp/a.tgz',
      checksum: 'x',
      sizeBytes: 1,
      submittedAt: '2026-06-05T00:00:00Z',
      reviewNotes: 'Looks good',
    };

    it('lists submissions with the CLI hint and approves a pending one', async () => {
      mockFetchSubmissions.mockResolvedValue([pending]);
      mockReview.mockResolvedValue({ success: true, message: 'Approved transcribe-audio' });
      mockRefresh.mockResolvedValue(undefined);
      const onPending = vi.fn();
      render(
        <TestWrapper>
          <Marketplace view="submissions" onPendingCount={onPending} />
        </TestWrapper>
      );
      expect(screen.getByText('crewly publish path/to/skill --submit')).toBeInTheDocument();
      expect(await screen.findByText('transcribe-audio')).toBeInTheDocument();
      expect(screen.getByText('Pending review')).toBeInTheDocument();
      expect(onPending).toHaveBeenCalledWith(1);

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(mockReview).toHaveBeenCalledWith('sub-1', 'approve'));
      await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    });

    it('rejects a pending submission', async () => {
      mockFetchSubmissions.mockResolvedValue([pending]);
      mockReview.mockResolvedValue({ success: true, message: 'Rejected' });
      render(
        <TestWrapper>
          <Marketplace view="submissions" />
        </TestWrapper>
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
      await waitFor(() => expect(mockReview).toHaveBeenCalledWith('sub-1', 'reject'));
    });

    it('opens a submission to show its description, version and review notes', async () => {
      mockFetchSubmissions.mockResolvedValue([{ ...pending, status: 'approved' as const }]);
      render(
        <TestWrapper>
          <Marketplace view="submissions" />
        </TestWrapper>
      );
      fireEvent.click(await screen.findByText('transcribe-audio'));
      const detail = screen.getByTestId('submission-detail-sub-1');
      expect(detail).toHaveTextContent('Transcribe audio to text with Whisper.');
      expect(detail).toHaveTextContent('Version 1.0.0');
      expect(detail).toHaveTextContent('Review: Looks good');
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('shows an empty state with no submissions', async () => {
      mockFetchSubmissions.mockResolvedValue([]);
      render(
        <TestWrapper>
          <Marketplace view="submissions" />
        </TestWrapper>
      );
      expect(await screen.findByText('No submissions yet.')).toBeInTheDocument();
    });
  });
});
