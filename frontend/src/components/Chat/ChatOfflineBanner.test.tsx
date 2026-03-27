/**
 * Chat Offline Banner Tests
 *
 * @module components/Chat/ChatOfflineBanner.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatOfflineBanner } from './ChatOfflineBanner';

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

/**
 * Wrapper providing router context.
 */
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

describe('ChatOfflineBanner', () => {
  it('renders with data-testid="orchestrator-offline-banner"', () => {
    render(<ChatOfflineBanner />, { wrapper: TestWrapper });
    expect(screen.getByTestId('orchestrator-offline-banner')).toBeInTheDocument();
  });

  it('shows "Orchestrator Offline" title', () => {
    render(<ChatOfflineBanner />, { wrapper: TestWrapper });
    expect(screen.getByText('Orchestrator Offline')).toBeInTheDocument();
  });

  it('shows default message when no message prop', () => {
    render(<ChatOfflineBanner />, { wrapper: TestWrapper });
    expect(screen.getByText('The orchestrator is not running.')).toBeInTheDocument();
  });

  it('shows custom message when provided', () => {
    render(
      <ChatOfflineBanner message="Please start the orchestrator." />,
      { wrapper: TestWrapper }
    );
    expect(screen.getByText('Please start the orchestrator.')).toBeInTheDocument();
  });

  it('renders a Dashboard button', () => {
    render(<ChatOfflineBanner />, { wrapper: TestWrapper });
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('navigates to "/" when Dashboard button is clicked', () => {
    render(<ChatOfflineBanner />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByText('Dashboard'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('renders a warning alert', () => {
    render(<ChatOfflineBanner />, { wrapper: TestWrapper });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
