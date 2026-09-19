/**
 * Tests for the Integrations tab after the move to /connections.
 *
 * @module components/Settings/IntegrationsTab.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { IntegrationsTab, connectionsRedirectUrl } from './IntegrationsTab';

describe('connectionsRedirectUrl', () => {
  it('maps the legacy ?tab=slack to ?platform=slack and keeps the connect flags', () => {
    expect(connectionsRedirectUrl('?tab=slack&slack=connected')).toBe('/connections?slack=connected&platform=slack');
    expect(connectionsRedirectUrl('?tab=integrations&google=connected')).toBe('/connections?google=connected');
    expect(connectionsRedirectUrl('?tab=integrations&canva=error&reason=access_denied')).toBe(
      '/connections?canva=error&reason=access_denied',
    );
  });

  it('keeps an explicit platform and handles an empty query', () => {
    expect(connectionsRedirectUrl('?platform=canva&tab=slack')).toBe('/connections?platform=canva');
    expect(connectionsRedirectUrl('')).toBe('/connections');
  });
});

describe('IntegrationsTab', () => {
  it('points at Connections for anyone whose redirect did not fire', () => {
    render(
      <MemoryRouter>
        <IntegrationsTab />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('integrations-moved')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to Connections/ })).toHaveAttribute('href', '/connections');
  });
});
