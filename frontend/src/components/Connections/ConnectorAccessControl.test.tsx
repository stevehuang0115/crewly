/**
 * Tests for the per-connector role allowlist control.
 *
 * @module components/Connections/ConnectorAccessControl.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConnectorAccessControl } from './ConnectorAccessControl';

const listRoles = vi.fn();
const updateConnectorAccess = vi.fn();
vi.mock('../../services/roles.service', () => ({ rolesService: { listRoles: (...a: unknown[]) => listRoles(...a) } }));
vi.mock('../../services/connector.service', () => ({
  updateConnectorAccess: (...a: unknown[]) => updateConnectorAccess(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  listRoles.mockResolvedValue([
    { name: 'developer', isHidden: false },
    { name: 'Ops', isHidden: false },
    { name: 'secret', isHidden: true },
  ]);
  updateConnectorAccess.mockImplementation(async (_id: string, roles: string[]) => roles);
});
afterEach(() => vi.restoreAllMocks());

describe('ConnectorAccessControl', () => {
  it('offers the orchestrator plus every visible role, and says "every agent" when nothing is picked', async () => {
    render(<ConnectorAccessControl connectorId="canva" allowedRoles={[]} />);
    await waitFor(() => expect(screen.getByTestId('connector-access-canva-role-developer')).toBeInTheDocument());
    expect(screen.getByTestId('connector-access-canva-role-orchestrator')).toBeInTheDocument();
    expect(screen.getByTestId('connector-access-canva-role-ops')).toBeInTheDocument();
    expect(screen.queryByTestId('connector-access-canva-role-secret')).not.toBeInTheDocument();
    expect(screen.getByText(/Every agent on this instance can use it/)).toBeInTheDocument();
  });

  it('saves a role on click and reports it upward', async () => {
    const onChange = vi.fn();
    render(<ConnectorAccessControl connectorId="canva" allowedRoles={[]} onChange={onChange} />);
    await waitFor(() => expect(screen.getByTestId('connector-access-canva-role-ops')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('connector-access-canva-role-ops'));
    await waitFor(() => expect(updateConnectorAccess).toHaveBeenCalledWith('canva', ['ops']));
    expect(onChange).toHaveBeenCalledWith(['ops']);
  });

  it('un-picking the last role, or clicking "Every agent", reopens the connector', async () => {
    render(<ConnectorAccessControl connectorId="google-workspace" allowedRoles={['ops']} />);
    await waitFor(() => expect(screen.getByTestId('connector-access-google-workspace-role-ops')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('connector-access-google-workspace-role-ops'));
    await waitFor(() => expect(updateConnectorAccess).toHaveBeenCalledWith('google-workspace', []));

    updateConnectorAccess.mockClear();
    render(<ConnectorAccessControl connectorId="canva" allowedRoles={['ops']} />);
    fireEvent.click(screen.getByTestId('connector-access-canva-every'));
    await waitFor(() => expect(updateConnectorAccess).toHaveBeenCalledWith('canva', []));
  });

  it('rolls the selection back and shows the error when the save fails', async () => {
    updateConnectorAccess.mockRejectedValue(new Error('disk full'));
    render(<ConnectorAccessControl connectorId="canva" allowedRoles={[]} />);
    await waitFor(() => expect(screen.getByTestId('connector-access-canva-role-ops')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('connector-access-canva-role-ops'));
    await waitFor(() => expect(screen.getByText('disk full')).toBeInTheDocument());
    expect(screen.getByText(/Every agent on this instance can use it/)).toBeInTheDocument();
  });
});
