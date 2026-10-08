/**
 * Tests for the Remote MCP servers card: Zoho preset help, the single-paste
 * add form, test results, rename/remove and per-server allowlists.
 *
 * @module components/Connections/RemoteMcpTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { RemoteMcpTab, NEXT_START_NOTE } from './RemoteMcpTab';

const api = {
  listRemoteMcp: vi.fn(),
  addRemoteMcp: vi.fn(),
  renameRemoteMcp: vi.fn(),
  removeRemoteMcp: vi.fn(),
  testRemoteMcp: vi.fn(),
  authorizeRemoteMcp: vi.fn(),
};
vi.mock('../../services/remote-mcp.service', () => ({
  listRemoteMcp: (...a: unknown[]) => api.listRemoteMcp(...a),
  addRemoteMcp: (...a: unknown[]) => api.addRemoteMcp(...a),
  renameRemoteMcp: (...a: unknown[]) => api.renameRemoteMcp(...a),
  removeRemoteMcp: (...a: unknown[]) => api.removeRemoteMcp(...a),
  testRemoteMcp: (...a: unknown[]) => api.testRemoteMcp(...a),
  authorizeRemoteMcp: (...a: unknown[]) => api.authorizeRemoteMcp(...a),
}));
vi.mock('./ConnectorAccessControl', () => ({
  ConnectorAccessControl: ({ connectorId, allowedRoles }: { connectorId: string; allowedRoles: string[] }) => (
    <div data-testid={`access-${connectorId}`}>{allowedRoles.join(',')}</div>
  ),
}));

const ZOHO = {
  id: 'zoho', label: 'Zoho', provider: 'zoho', urlMasked: 'https://crm-1.zohomcp.com/…', headerNames: [], createdAt: '', connectorId: 'mcp:zoho',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listRemoteMcp.mockResolvedValue([]);
});

describe('RemoteMcpTab', () => {
  it('starts on the Zoho preset with its help text and an empty state', async () => {
    render(<RemoteMcpTab />);
    await waitFor(() => expect(screen.getByTestId('remote-mcp-empty')).toBeInTheDocument());
    expect(screen.getByTestId('remote-mcp-help')).toHaveTextContent(
      'Create a server at mcp.zoho.com, pick the Zoho apps it may use, then paste its URL here.',
    );
    expect(screen.getByTestId('remote-mcp-label')).toHaveValue('Zoho');
    expect(screen.getByTestId('remote-mcp-add')).toBeDisabled();
  });

  it('adds a server from a pasted URL and says when it applies', async () => {
    api.addRemoteMcp.mockResolvedValue({ server: ZOHO });
    render(<RemoteMcpTab />);
    fireEvent.change(screen.getByTestId('remote-mcp-url'), { target: { value: ' https://crm-1.zohomcp.com/mcp/KEY/message ' } });
    api.listRemoteMcp.mockResolvedValue([ZOHO]);
    fireEvent.click(screen.getByTestId('remote-mcp-add'));
    await waitFor(() => expect(api.addRemoteMcp).toHaveBeenCalledWith({ label: 'Zoho', url: 'https://crm-1.zohomcp.com/mcp/KEY/message', provider: 'zoho' }));
    await waitFor(() => expect(screen.getByText(`Zoho added. ${NEXT_START_NOTE}`)).toBeInTheDocument());
    expect(screen.getByTestId('remote-mcp-url')).toHaveValue('');
    expect(screen.getByTestId('remote-mcp-host-zoho')).toHaveTextContent('https://crm-1.zohomcp.com/…');
  });

  it('switching to Other swaps the default name and help', async () => {
    render(<RemoteMcpTab />);
    fireEvent.click(screen.getByTestId('remote-mcp-preset-custom'));
    expect(screen.getByTestId('remote-mcp-label')).toHaveValue('Other');
    expect(screen.getByTestId('remote-mcp-help')).toHaveTextContent('any remote');
  });

  it('shows an add error', async () => {
    api.addRemoteMcp.mockRejectedValue(new Error('The URL must start with https://'));
    render(<RemoteMcpTab />);
    fireEvent.change(screen.getByTestId('remote-mcp-url'), { target: { value: 'http://x' } });
    fireEvent.click(screen.getByTestId('remote-mcp-add'));
    await waitFor(() => expect(screen.getByText('The URL must start with https://')).toBeInTheDocument());
  });

  it('lists servers with their own allowlist and runs a test', async () => {
    api.listRemoteMcp.mockResolvedValue([ZOHO]);
    api.testRemoteMcp.mockResolvedValue({ ok: true, toolCount: 2, tools: ['ZohoCRM_getRecords', 'ZohoMail_sendMail'] });
    render(<RemoteMcpTab access={{ 'mcp:zoho': { allowedRoles: ['sales'] } }} />);
    await waitFor(() => expect(screen.getByTestId('access-mcp:zoho')).toHaveTextContent('sales'));
    fireEvent.click(screen.getByTestId('remote-mcp-test-zoho'));
    await waitFor(() => expect(screen.getByTestId('remote-mcp-test-result-zoho')).toHaveTextContent('Connected — 2 tools: ZohoCRM_getRecords, ZohoMail_sendMail'));
  });

  it('shows a failed test', async () => {
    api.listRemoteMcp.mockResolvedValue([ZOHO]);
    api.testRemoteMcp.mockResolvedValue({ ok: false, error: 'The server refused the request (401).' });
    render(<RemoteMcpTab />);
    fireEvent.click(await screen.findByTestId('remote-mcp-test-zoho'));
    await waitFor(() => expect(screen.getByTestId('remote-mcp-test-result-zoho')).toHaveTextContent('401'));
  });

  it('renames and removes', async () => {
    api.listRemoteMcp.mockResolvedValue([ZOHO]);
    api.renameRemoteMcp.mockResolvedValue({ ...ZOHO, label: 'Zoho CRM' });
    api.removeRemoteMcp.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RemoteMcpTab />);
    fireEvent.click(await screen.findByTestId('remote-mcp-rename-zoho'));
    fireEvent.change(screen.getByTestId('remote-mcp-rename-input-zoho'), { target: { value: 'Zoho CRM' } });
    fireEvent.click(screen.getByTestId('remote-mcp-rename-save-zoho'));
    await waitFor(() => expect(api.renameRemoteMcp).toHaveBeenCalledWith('zoho', 'Zoho CRM'));

    fireEvent.click(screen.getByTestId('remote-mcp-remove-zoho'));
    await waitFor(() => expect(api.removeRemoteMcp).toHaveBeenCalledWith('zoho'));
  });

  it('shows an OAuth server that needs a sign-in with its Authorize link', async () => {
    const link = 'https://api.crewlyai.com/api/cloud/mcp-oauth/go/T1';
    api.listRemoteMcp.mockResolvedValue([{ ...ZOHO, auth: { mode: 'oauth', status: 'needs_auth', authorizeUrl: link } }]);
    render(<RemoteMcpTab />);
    const a = await screen.findByTestId('remote-mcp-authorize-link-zoho');
    expect(a.getAttribute('href')).toBe(link);
    expect(screen.getByTestId('remote-mcp-auth-needed-zoho').textContent).toContain('sign in once');
  });

  it('gets a sign-in link, or sends it to Slack', async () => {
    api.listRemoteMcp.mockResolvedValue([{ ...ZOHO, auth: { mode: 'oauth', status: 'needs_auth' } }]);
    api.authorizeRemoteMcp.mockResolvedValue({ url: 'https://x/go/T', expiresAt: '', posted: true });
    render(<RemoteMcpTab />);
    fireEvent.click(await screen.findByTestId('remote-mcp-authorize-zoho'));
    await waitFor(() => expect(api.authorizeRemoteMcp).toHaveBeenCalledWith('zoho', { notify: false }));
    fireEvent.click(screen.getByTestId('remote-mcp-authorize-slack-zoho'));
    await waitFor(() => expect(api.authorizeRemoteMcp).toHaveBeenCalledWith('zoho', { notify: true }));
    expect(await screen.findByText(/Sent the Zoho sign-in link to your Slack DM/)).toBeTruthy();
  });

  it('shows a signed-in OAuth server without an Authorize button', async () => {
    api.listRemoteMcp.mockResolvedValue([{ ...ZOHO, auth: { mode: 'oauth', status: 'connected', authorizationServer: 'accounts.zoho.com', scopes: ['ZohoMCP.tools.ALL'] } }]);
    render(<RemoteMcpTab />);
    expect((await screen.findByTestId('remote-mcp-auth-zoho')).textContent).toContain('Signed in via accounts.zoho.com');
    expect(screen.queryByTestId('remote-mcp-authorize-zoho')).toBeNull();
  });

  it('says a newly added server needs a sign-in', async () => {
    api.addRemoteMcp.mockResolvedValue({ server: ZOHO, authorize: { url: 'https://x/go/T', expiresAt: '', posted: true } });
    render(<RemoteMcpTab />);
    fireEvent.change(await screen.findByTestId('remote-mcp-url'), { target: { value: 'https://crm-1.zohomcp.com/mcp/k/message' } });
    fireEvent.click(screen.getByTestId('remote-mcp-add'));
    expect(await screen.findByText(/needs you to sign in once — the link is in your Slack DM too/)).toBeTruthy();
  });
});
