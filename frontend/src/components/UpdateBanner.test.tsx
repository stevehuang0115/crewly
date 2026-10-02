/**
 * UpdateBanner Tests
 *
 * @module components/UpdateBanner.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { UpdateBanner as RawUpdateBanner } from './UpdateBanner';

/** The banner links to Settings, so it needs a router. */
const UpdateBanner: React.FC = () => (
  <MemoryRouter>
    <RawUpdateBanner />
  </MemoryRouter>
);

vi.mock('../hooks/useVersionCheck', () => ({
  useVersionCheck: vi.fn(() => ({
    versionInfo: null,
    isLoading: true,
  })),
}));

import { useVersionCheck } from '../hooks/useVersionCheck';
const mockedUseVersionCheck = useVersionCheck as ReturnType<typeof vi.fn>;

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render nothing when loading', () => {
    mockedUseVersionCheck.mockReturnValue({
      versionInfo: null,
      isLoading: true,
    });

    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('should render nothing when no update is available', () => {
    mockedUseVersionCheck.mockReturnValue({
      versionInfo: {
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      },
      isLoading: false,
    });

    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('should render nothing when versionInfo is null', () => {
    mockedUseVersionCheck.mockReturnValue({
      versionInfo: null,
      isLoading: false,
    });

    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('should render banner when update is available', () => {
    mockedUseVersionCheck.mockReturnValue({
      versionInfo: {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
      },
      isLoading: false,
    });

    render(<UpdateBanner />);

    expect(screen.getByText('Update Available')).toBeInTheDocument();
    expect(screen.getByTestId('update-banner-link')).toHaveAttribute('href', '/settings?tab=system');
  });

  it('should dismiss banner when X button is clicked', async () => {
    const user = userEvent.setup();

    mockedUseVersionCheck.mockReturnValue({
      versionInfo: {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
      },
      isLoading: false,
    });

    render(<UpdateBanner />);

    expect(screen.getByText('Update Available')).toBeInTheDocument();

    const dismissButton = screen.getByRole('button', { name: 'Dismiss update banner' });
    await user.click(dismissButton);

    expect(screen.queryByText('Update Available')).not.toBeInTheDocument();
  });
});
