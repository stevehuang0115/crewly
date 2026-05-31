/**
 * Tests for SopCatalogModal — lists the catalog, installs/uninstalls, and
 * notifies the caller to refresh.
 *
 * @module components/Wiki/SopCatalogModal.test
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SopCatalogModal } from './SopCatalogModal';

const CATALOG = [
  { path: 'common/blocker-handling.md', title: 'Blocker Handling', category: 'common', bytes: 100, installed: false },
  { path: 'pm/progress-tracking.md', title: 'Progress Tracking', category: 'pm', bytes: 200, installed: true },
];

describe('SopCatalogModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(catalog = CATALOG) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sop-catalog?')) {
        return { ok: true, json: async () => ({ success: true, catalog }) } as Response;
      }
      // install / uninstall
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });
  }

  it('lists catalog entries grouped, with installed state', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<SopCatalogModal vaultPath="/v/wiki" onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Blocker Handling')).toBeInTheDocument());
    expect(screen.getByTestId('sop-toggle-common/blocker-handling.md')).toHaveTextContent('Install');
    expect(screen.getByTestId('sop-toggle-pm/progress-tracking.md')).toHaveTextContent('Installed');
  });

  it('installs a SOP and notifies onChanged', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    render(<SopCatalogModal vaultPath="/v/wiki" onClose={vi.fn()} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText('Blocker Handling')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sop-toggle-common/blocker-handling.md'));

    await waitFor(() =>
      expect(screen.getByTestId('sop-toggle-common/blocker-handling.md')).toHaveTextContent('Installed'),
    );
    expect(onChanged).toHaveBeenCalled();
    const installCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/sop-catalog/install'));
    expect(installCall).toBeTruthy();
    expect(JSON.parse((installCall![1] as RequestInit).body as string)).toEqual({
      vaultPath: '/v/wiki',
      sopPath: 'common/blocker-handling.md',
    });
  });

  it('calls onClose when the close button is clicked', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const onClose = vi.fn();
    render(<SopCatalogModal vaultPath="/v/wiki" onClose={onClose} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Blocker Handling')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error when the catalog fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: false, error: 'boom' }) }) as Response),
    );
    render(<SopCatalogModal vaultPath="/v/wiki" onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
