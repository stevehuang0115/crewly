/**
 * Tests for the Connections page — grouping, the ?platform= deep link the
 * OAuth flows return with, and the role-allowlist badge.
 *
 * @module pages/Connections.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Connections, { initialConnectorFromUrl } from './Connections';

vi.mock('../components/Settings/SlackTab', () => ({ SlackTab: () => <div data-testid="slack-panel" /> }));
vi.mock('../components/Settings/WhatsAppTab', () => ({ WhatsAppTab: () => <div data-testid="whatsapp-panel" /> }));
vi.mock('../components/Settings/DiscordTab', () => ({ DiscordTab: () => <div data-testid="discord-panel" /> }));
vi.mock('../components/Settings/TelegramTab', () => ({ TelegramTab: () => <div data-testid="telegram-panel" /> }));
vi.mock('../components/Settings/GoogleChatTab', () => ({ GoogleChatTab: () => <div data-testid="google-chat-panel" /> }));
vi.mock('../components/Settings/GoogleWorkspaceTab', () => ({ GoogleWorkspaceTab: () => <div data-testid="google-workspace-panel" /> }));
vi.mock('../components/Settings/CanvaTab', () => ({ CanvaTab: () => <div data-testid="canva-panel" /> }));
vi.mock('../components/Settings/MicrosoftTodoTab', () => ({ MicrosoftTodoTab: () => <div data-testid="microsoft-todo-panel" /> }));
vi.mock('../components/Connections/ConnectorAccessControl', () => ({
  ConnectorAccessControl: ({ connectorId }: { connectorId: string }) => <div data-testid={`access-${connectorId}`} />,
}));

const fetchConnectorAccess = vi.fn();
vi.mock('../services/connector.service', () => ({
  fetchConnectorAccess: (...args: unknown[]) => fetchConnectorAccess(...args),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <Connections />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  fetchConnectorAccess.mockResolvedValue({});
  window.history.replaceState({}, '', '/connections');
});
afterEach(() => vi.restoreAllMocks());

describe('Connections', () => {
  it('lists messaging and data connectors in their own sections', () => {
    renderPage();
    const messaging = screen.getByTestId('connector-group-messaging');
    const data = screen.getByTestId('connector-group-data');
    expect(messaging).toContainElement(screen.getByTestId('connector-card-slack'));
    expect(messaging).toContainElement(screen.getByTestId('connector-card-google-chat'));
    expect(data).toContainElement(screen.getByTestId('connector-card-google-workspace'));
    expect(data).toContainElement(screen.getByTestId('connector-card-canva'));
    expect(messaging).not.toContainElement(screen.getByTestId('connector-card-canva'));
    expect(data).toContainElement(screen.getByTestId('connector-card-microsoft-todo'));
  });

  it('opens the card named by ?platform= (where every OAuth flow returns)', () => {
    window.history.replaceState({}, '', '/connections?platform=canva&canva=connected');
    renderPage();
    expect(screen.getByTestId('connector-content-canva')).toBeInTheDocument();
    expect(screen.getByTestId('canva-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('connector-content-slack')).not.toBeInTheDocument();
  });

  it('opens the Microsoft To Do card with its role allowlist on ?platform=microsoft-todo', () => {
    window.history.replaceState({}, '', '/connections?platform=microsoft-todo&microsoft=connected');
    renderPage();
    expect(screen.getByTestId('microsoft-todo-panel')).toBeInTheDocument();
    expect(screen.getByTestId('access-microsoft-todo')).toBeInTheDocument();
  });

  it('still understands the legacy ?tab=slack return, and ignores unknown ids', () => {
    window.history.replaceState({}, '', '/connections?tab=slack');
    expect(initialConnectorFromUrl()).toBe('slack');
    window.history.replaceState({}, '', '/connections?platform=nope');
    expect(initialConnectorFromUrl()).toBeNull();
  });

  it('expands and collapses a card, showing the access control only for data connectors', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('connector-toggle-google-workspace'));
    expect(screen.getByTestId('access-google-workspace')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('connector-toggle-slack'));
    expect(screen.queryByTestId('connector-content-google-workspace')).not.toBeInTheDocument();
    expect(screen.getByTestId('connector-content-slack')).toBeInTheDocument();
    expect(screen.queryByTestId('access-slack')).not.toBeInTheDocument();
  });

  it('badges a restricted connector with its role count, and survives an access-read failure', async () => {
    fetchConnectorAccess.mockResolvedValue({ canva: { allowedRoles: ['ops', 'support'] } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('connector-restricted-canva')).toHaveTextContent('2 roles'));
    expect(screen.queryByTestId('connector-restricted-google-workspace')).not.toBeInTheDocument();

    fetchConnectorAccess.mockRejectedValue(new Error('offline'));
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('connector-card-canva').length).toBeGreaterThan(0));
  });
});
