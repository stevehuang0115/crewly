/**
 * Tests for InstallLog.
 *
 * @module components/Harness/InstallLog.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { InstallLog } from './InstallLog';

describe('InstallLog', () => {
  it('renders the log text in a live log region', () => {
    render(<InstallLog log={'added 1 package\ndone'} />);
    const log = screen.getByTestId('install-log');
    expect(log).toHaveAttribute('role', 'log');
    expect(log.textContent).toContain('added 1 package');
  });

  it('shows a placeholder while empty', () => {
    render(<InstallLog log="" />);
    expect(screen.getByTestId('install-log').textContent).toBe('…');
  });
});
