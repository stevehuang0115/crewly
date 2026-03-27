/**
 * MarketplaceDetail Page Tests
 *
 * Tests for the marketplace item detail page including rendering,
 * install/uninstall actions, and error states.
 *
 * @module pages/MarketplaceDetail.test
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MarketplaceDetail from './MarketplaceDetail';
import type { MarketplaceItemWithStatus } from '../types/marketplace.types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  Star: () => <svg data-testid="star-icon" />,
  Download: () => <svg data-testid="download-icon" />,
  Package: () => <svg data-testid="package-icon" />,
  Check: () => <svg data-testid="check-icon" />,
  ArrowUp: () => <svg data-testid="arrow-up-icon" />,
  User: () => <svg data-testid="user-icon" />,
  Calendar: () => <svg data-testid="calendar-icon" />,
  Tag: () => <svg data-testid="tag-icon" />,
  Shield: () => <svg data-testid="shield-icon" />,
  X: () => <svg data-testid="x-icon" />,
}));

// Mock marketplace service
const mockFetchItem = vi.fn();
const mockInstall = vi.fn();
const mockUninstall = vi.fn();

vi.mock('../services/marketplace.service', () => ({
  fetchMarketplaceItem: (...args: unknown[]) => mockFetchItem(...args),
  installMarketplaceItem: (...args: unknown[]) => mockInstall(...args),
  uninstallMarketplaceItem: (...args: unknown[]) => mockUninstall(...args),
}));

// Mock navigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

/** Create a mock marketplace item for testing */
function createMockItem(overrides: Partial<MarketplaceItemWithStatus> = {}): MarketplaceItemWithStatus {
  return {
    id: 'skill-1',
    type: 'skill',
    name: 'Test Skill',
    description: 'A detailed test skill for testing purposes',
    author: 'Test Author',
    version: '1.0.0',
    category: 'development',
    tags: ['test', 'automation'],
    license: 'MIT',
    downloads: 2500,
    rating: 4.5,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-01T00:00:00Z',
    assets: {},
    installStatus: 'not_installed',
    metadata: { readme: '# Test Skill\n\nThis is a test skill README.' },
    ...overrides,
  };
}

/** Wrapper that renders the detail page at /marketplace/:id */
const TestWrapper: React.FC<{ id?: string }> = ({ id = 'skill-1' }) => (
  <MemoryRouter initialEntries={[`/marketplace/${id}`]}>
    <Routes>
      <Route path="/marketplace/:id" element={<MarketplaceDetail />} />
      <Route path="/marketplace" element={<div>Marketplace List</div>} />
    </Routes>
  </MemoryRouter>
);

describe('MarketplaceDetail Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchItem.mockResolvedValue(createMockItem());
  });

  describe('Rendering', () => {
    it('should render item name and description', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('item-name')).toHaveTextContent('Test Skill');
        expect(screen.getByTestId('item-description')).toHaveTextContent('A detailed test skill');
      });
    });

    it('should render back to marketplace link', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('back-to-marketplace')).toBeInTheDocument();
      });
    });

    it('should navigate back on back button click', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('back-to-marketplace')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('back-to-marketplace'));
      expect(mockNavigate).toHaveBeenCalledWith('/marketplace');
    });

    it('should display item metadata (author, rating, downloads, license)', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Test Author')).toBeInTheDocument();
        expect(screen.getByText('4.5')).toBeInTheDocument();
        expect(screen.getByText('2.5k')).toBeInTheDocument();
        expect(screen.getByText('MIT')).toBeInTheDocument();
      });
    });

    it('should display tags', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('test')).toBeInTheDocument();
        expect(screen.getByText('automation')).toBeInTheDocument();
      });
    });

    it('should display README content', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('readme-section')).toBeInTheDocument();
        expect(screen.getByText(/# Test Skill/)).toBeInTheDocument();
      });
    });

    it('should show "No README available" when readme is missing', async () => {
      mockFetchItem.mockResolvedValue(createMockItem({ metadata: {} }));

      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('No README available for this item.')).toBeInTheDocument();
      });
    });

    it('should display type badge', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('skill')).toBeInTheDocument();
      });
    });

    it('should display version', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('v1.0.0')).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading state initially', () => {
      mockFetchItem.mockReturnValue(new Promise(() => {}));

      render(<TestWrapper />);

      expect(screen.getByText('Loading item details...')).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('should show error when fetch fails', async () => {
      mockFetchItem.mockRejectedValue(new Error('Not found'));

      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load item details')).toBeInTheDocument();
      });
    });
  });

  describe('Install/Uninstall Actions', () => {
    it('should show Install button for not_installed items', async () => {
      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('install-btn')).toBeInTheDocument();
      });
    });

    it('should call installMarketplaceItem on install', async () => {
      mockInstall.mockResolvedValue({ success: true, message: 'Installed' });

      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('install-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('install-btn'));

      await waitFor(() => {
        expect(mockInstall).toHaveBeenCalledWith('skill-1');
      });
    });

    it('should show Uninstall button for installed items', async () => {
      mockFetchItem.mockResolvedValue(createMockItem({ installStatus: 'installed' }));

      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('uninstall-btn')).toBeInTheDocument();
      });
    });

    it('should show check icon for installed items', async () => {
      mockFetchItem.mockResolvedValue(createMockItem({ installStatus: 'installed' }));

      render(<TestWrapper />);

      await waitFor(() => {
        expect(screen.getByTestId('check-icon')).toBeInTheDocument();
      });
    });
  });
});
