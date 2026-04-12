/**
 * CostDashboard Page Tests
 *
 * @module pages/CostDashboard.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CostDashboard } from './CostDashboard';
import { apiService } from '../services/api.service';

// Mock the API service
vi.mock('../services/api.service', () => ({
  apiService: {
    getTokenUsage: vi.fn(),
  },
}));

const mockApiService = vi.mocked(apiService);

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

const mockUsageData = [
  { sessionName: 'agent-opus-1', agentId: 'a1', totalInput: 1000, totalOutput: 500, eventCount: 3 },
  { sessionName: 'agent-sonnet-1', agentId: 'a2', totalInput: 2000, totalOutput: 1000, eventCount: 5 },
];

describe('CostDashboard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorageMock.clear();
  });

  it('should show loading state initially', () => {
    mockApiService.getTokenUsage.mockImplementation(() => new Promise(() => {}));

    render(<CostDashboard />);

    expect(screen.getByText('Loading cost data...')).toBeInTheDocument();
  });

  it('should render dashboard with data', async () => {
    mockApiService.getTokenUsage.mockResolvedValueOnce(mockUsageData);

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('cost-dashboard')).toBeInTheDocument();
    });

    expect(screen.getByText('Usage')).toBeInTheDocument();
    expect(screen.getByTestId('budget-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('token-summary-cards')).toBeInTheDocument();
    expect(screen.getByTestId('agent-usage-table')).toBeInTheDocument();
    expect(screen.getByTestId('budget-config-panel')).toBeInTheDocument();
  });

  it('should show empty state when no data', async () => {
    mockApiService.getTokenUsage.mockResolvedValueOnce([]);

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('cost-dashboard-empty')).toBeInTheDocument();
    });

    expect(screen.getByText('No usage data yet')).toBeInTheDocument();
  });

  it('should show error state on API failure', async () => {
    mockApiService.getTokenUsage.mockRejectedValueOnce(new Error('API is down'));

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('cost-dashboard-error')).toBeInTheDocument();
    });

    expect(screen.getByText('Failed to load cost data')).toBeInTheDocument();
    expect(screen.getByText('API is down')).toBeInTheDocument();
  });

  it('should display last updated timestamp', async () => {
    mockApiService.getTokenUsage.mockResolvedValueOnce(mockUsageData);

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('last-updated')).toBeInTheDocument();
    });

    expect(screen.getByTestId('last-updated')).toHaveTextContent(/Last updated:/);
  });

  it('should have a refresh button', async () => {
    mockApiService.getTokenUsage.mockResolvedValue(mockUsageData);

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('refresh-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('refresh-btn'));

    await waitFor(() => {
      expect(mockApiService.getTokenUsage).toHaveBeenCalledTimes(2);
    });
  });

  it('should have a retry button on error state', async () => {
    mockApiService.getTokenUsage
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(mockUsageData);

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(mockApiService.getTokenUsage).toHaveBeenCalledTimes(2);
    });
  });

  it('should render page description', async () => {
    mockApiService.getTokenUsage.mockResolvedValueOnce(mockUsageData);

    render(<CostDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Monitor token usage and spending/)).toBeInTheDocument();
    });
  });
});
