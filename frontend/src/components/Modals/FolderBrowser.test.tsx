/**
 * FolderBrowser tests — server-side directory picker.
 *
 * @module components/Modals/FolderBrowser.test
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FolderBrowser } from './FolderBrowser';

const listing = {
  success: true,
  data: {
    currentPath: '/home/me',
    parentPath: '/home',
    entries: [{ name: 'app', path: '/home/me/app', type: 'directory', isHidden: false }],
  },
};

describe('FolderBrowser', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(listing) }) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the directory returned by the server', async () => {
    render(<FolderBrowser onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('app')).toBeInTheDocument();
    expect(screen.getByText('/home/me')).toBeInTheDocument();
  });

  it('selects the current folder in basic mode', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FolderBrowser onSelect={onSelect} onClose={onClose} />);
    await screen.findByText('app');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelect).toHaveBeenCalledWith('/home/me');
    expect(onClose).toHaveBeenCalled();
  });

  it('creates a project on double-click in project mode', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<FolderBrowser onCreateProject={onCreateProject} onClose={onClose} />);
    fireEvent.doubleClick(await screen.findByText('app'));
    await waitFor(() => expect(onCreateProject).toHaveBeenCalledWith('/home/me/app'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'Permission denied' }),
    }) as unknown as typeof fetch;
    render(<FolderBrowser onSelect={vi.fn()} onClose={vi.fn()} />);
    expect((await screen.findAllByText('Permission denied')).length).toBeGreaterThan(0);
  });

  it('navigates up with the Go up button', async () => {
    render(<FolderBrowser onSelect={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('app');
    fireEvent.click(screen.getByRole('button', { name: 'Go up' }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith(expect.stringContaining('path=%2Fhome')),
    );
  });
});
