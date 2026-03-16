/**
 * Tests for Settings Page
 *
 * @module pages/Settings.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { Settings } from './Settings';

// Mock the tab components
vi.mock('../components/Settings/GeneralTab', () => ({
  GeneralTab: () => <div data-testid="general-tab">General Tab Content</div>,
}));

vi.mock('../components/Settings/RolesTab', () => ({
  RolesTab: () => <div data-testid="roles-tab">Roles Tab Content</div>,
}));

vi.mock('../components/Settings/SkillsTab', () => ({
  SkillsTab: () => <div data-testid="skills-tab">Skills Tab Content</div>,
}));

vi.mock('../components/Settings/IntegrationsTab', () => ({
  IntegrationsTab: () => <div data-testid="integrations-tab">Integrations Tab Content</div>,
}));

vi.mock('../components/Settings/CloudTab', () => ({
  CloudTab: () => <div data-testid="cloud-tab">Cloud Tab Content</div>,
}));

describe('Settings Page', () => {
  describe('Rendering', () => {
    it('should render settings page with header', () => {
      render(<Settings />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByText(/Configure Crewly/)).toBeInTheDocument();
    });

    it('should show all tab buttons', () => {
      render(<Settings />);

      expect(screen.getByText('General')).toBeInTheDocument();
      expect(screen.getByText('Roles')).toBeInTheDocument();
      expect(screen.getByText('Skills')).toBeInTheDocument();
      expect(screen.getByText('Integrations')).toBeInTheDocument();
      expect(screen.getByText('Cloud')).toBeInTheDocument();
    });
  });

  describe('Tab Navigation', () => {
    it('should show General tab by default', () => {
      render(<Settings />);

      expect(screen.getByTestId('general-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('roles-tab')).not.toBeInTheDocument();
      expect(screen.queryByTestId('skills-tab')).not.toBeInTheDocument();
      expect(screen.queryByTestId('integrations-tab')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cloud-tab')).not.toBeInTheDocument();
    });

    it('should switch to Cloud tab when clicked', () => {
      render(<Settings />);

      fireEvent.click(screen.getByText('Cloud'));

      expect(screen.getByTestId('cloud-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('general-tab')).not.toBeInTheDocument();
    });

    it('should switch to Integrations tab when clicked', () => {
      render(<Settings />);

      fireEvent.click(screen.getByText('Integrations'));

      expect(screen.getByTestId('integrations-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('general-tab')).not.toBeInTheDocument();
    });

    it('should switch to Roles tab when clicked', () => {
      render(<Settings />);

      fireEvent.click(screen.getByText('Roles'));

      expect(screen.getByTestId('roles-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('general-tab')).not.toBeInTheDocument();
    });

    it('should switch to Skills tab when clicked', () => {
      render(<Settings />);

      fireEvent.click(screen.getByText('Skills'));

      expect(screen.getByTestId('skills-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('general-tab')).not.toBeInTheDocument();
    });

    it('should switch back to General tab from another tab', () => {
      render(<Settings />);

      fireEvent.click(screen.getByText('Roles'));
      expect(screen.getByTestId('roles-tab')).toBeInTheDocument();

      fireEvent.click(screen.getByText('General'));
      expect(screen.getByTestId('general-tab')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper tab role attributes', () => {
      render(<Settings />);

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(5);
    });

    it('should set aria-selected on active tab', () => {
      render(<Settings />);

      const generalTab = screen.getByText('General').closest('button');
      const integrationsTab = screen.getByText('Integrations').closest('button');

      expect(generalTab).toHaveAttribute('aria-selected', 'true');
      expect(integrationsTab).toHaveAttribute('aria-selected', 'false');

      fireEvent.click(screen.getByText('Integrations'));

      expect(generalTab).toHaveAttribute('aria-selected', 'false');
      expect(integrationsTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should have tabpanel role on content area', () => {
      render(<Settings />);

      const tabpanel = screen.getByRole('tabpanel');
      expect(tabpanel).toBeInTheDocument();
    });
  });
});
