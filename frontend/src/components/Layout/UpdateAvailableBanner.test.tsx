/**
 * UpdateAvailableBanner Tests (#1010 review)
 *
 * @module components/Layout/UpdateAvailableBanner.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { DASHBOARD_UPDATED_EVENT } from '../../services/dashboard-build.service';

describe('UpdateAvailableBanner', () => {
  it('stays hidden until an update is announced, then offers a reload', () => {
    const reload = vi.fn();
    render(<UpdateAvailableBanner reload={reload} isHidden={() => false} />);
    expect(screen.queryByTestId('update-available-banner')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(DASHBOARD_UPDATED_EVENT));
    });
    expect(screen.getByTestId('update-available-banner').textContent).toContain('Crewly was updated');
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Reload/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads a tab that is not in view by itself', () => {
    const reload = vi.fn();
    render(<UpdateAvailableBanner reload={reload} isHidden={() => true} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DASHBOARD_UPDATED_EVENT));
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('update-available-banner')).toBeNull();
  });
});
