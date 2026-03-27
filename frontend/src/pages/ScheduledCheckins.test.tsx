/**
 * Scheduled Checkins Page Tests
 *
 * Tests for the top-level tab layout (Scheduled Messages | Cron Jobs)
 * and core page rendering.
 *
 * @module pages/ScheduledCheckins.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ScheduledCheckins } from './ScheduledCheckins';

// Mock the ScheduledCheckins sub-components
vi.mock('../components/ScheduledCheckins', () => ({
  ScheduledMessageCard: () => <div data-testid="message-card">Message</div>,
  ScheduledCheckCard: () => <div data-testid="check-card">Check</div>,
  TabNavigation: ({ activeTab, setActiveTab }: { activeTab: string; setActiveTab: (t: string) => void }) => (
    <div data-testid="tab-navigation" data-active={activeTab}>
      <button onClick={() => setActiveTab('active')}>Active</button>
      <button onClick={() => setActiveTab('completed')}>Completed</button>
    </div>
  ),
  EmptyState: ({ type }: { type: string }) => <div data-testid={`empty-${type}`}>Empty {type}</div>,
  MessageForm: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div data-testid="message-form">Form</div> : null,
  DeliveryLogsTable: () => <div data-testid="delivery-logs">Logs</div>,
  useScheduledMessages: () => ({
    scheduledMessages: [],
    scheduledChecks: [],
    deliveryLogs: [],
    teamOptions: [],
    loading: false,
    showCreateModal: false,
    editingMessage: null,
    formData: {},
    setFormData: vi.fn(),
    handleSubmit: vi.fn(),
    handleDelete: vi.fn(),
    handleToggleActive: vi.fn(),
    handleRunNow: vi.fn(),
    handleEdit: vi.fn(),
    handleCreate: vi.fn(),
    handleCloseModal: vi.fn(),
    handleCancelCheck: vi.fn(),
    clearDeliveryLogs: vi.fn(),
    formatDate: vi.fn((d: string) => d),
    AlertComponent: () => null,
    ConfirmComponent: () => null,
  }),
  ActiveTab: undefined,
}));

// Mock CronJobPanel
vi.mock('@/components/Settings/CronJobPanel', () => ({
  CronJobPanel: () => <div data-testid="cron-job-panel">Cron Jobs Panel</div>,
}));

// Mock LoadingSpinner
vi.mock('@/components/UI/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text: string }) => <div data-testid="loading">{text}</div>,
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Plus: () => <span data-testid="icon-plus">+</span>,
}));

describe('ScheduledCheckins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Page title ─────────────────────────────────────────────

  it('renders the page title', () => {
    render(<ScheduledCheckins />);
    expect(screen.getByText('Schedules & Cron')).toBeInTheDocument();
  });

  // ── Top-level tab bar ──────────────────────────────────────

  describe('top-level tab bar', () => {
    it('renders Scheduled Messages and Cron Jobs tabs', () => {
      render(<ScheduledCheckins />);
      expect(screen.getByRole('tab', { name: 'Scheduled Messages' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Cron Jobs' })).toBeInTheDocument();
    });

    it('shows Scheduled Messages tab as selected by default', () => {
      render(<ScheduledCheckins />);
      const messagesTab = screen.getByRole('tab', { name: 'Scheduled Messages' });
      expect(messagesTab).toHaveAttribute('aria-selected', 'true');
    });

    it('shows messages content by default (TabNavigation visible)', () => {
      render(<ScheduledCheckins />);
      expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
    });

    it('does not show CronJobPanel on messages tab', () => {
      render(<ScheduledCheckins />);
      expect(screen.queryByTestId('cron-job-panel')).toBeNull();
    });

    it('switches to Cron Jobs tab and shows CronJobPanel', () => {
      render(<ScheduledCheckins />);
      fireEvent.click(screen.getByRole('tab', { name: 'Cron Jobs' }));

      expect(screen.getByTestId('cron-job-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('tab-navigation')).toBeNull();
    });

    it('switches back to Scheduled Messages from Cron Jobs', () => {
      render(<ScheduledCheckins />);
      fireEvent.click(screen.getByRole('tab', { name: 'Cron Jobs' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Scheduled Messages' }));

      expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      expect(screen.queryByTestId('cron-job-panel')).toBeNull();
    });
  });

  // ── Dynamic button label ───────────────────────────────────

  describe('create button', () => {
    it('shows "New Scheduled Message" on messages tab', () => {
      render(<ScheduledCheckins />);
      expect(screen.getByText('New Scheduled Message')).toBeInTheDocument();
    });

    it('hides page-level create button on cron tab (CronJobPanel has its own)', () => {
      render(<ScheduledCheckins />);
      fireEvent.click(screen.getByRole('tab', { name: 'Cron Jobs' }));
      expect(screen.queryByText('New Scheduled Message')).not.toBeInTheDocument();
    });
  });

  // ── Tab accessibility ──────────────────────────────────────

  describe('accessibility', () => {
    it('has tablist role on the tab container', () => {
      render(<ScheduledCheckins />);
      expect(screen.getByRole('tablist', { name: 'Page sections' })).toBeInTheDocument();
    });

    it('aria-selected reflects the active tab', () => {
      render(<ScheduledCheckins />);
      const cronTab = screen.getByRole('tab', { name: 'Cron Jobs' });
      expect(cronTab).toHaveAttribute('aria-selected', 'false');

      fireEvent.click(cronTab);
      expect(cronTab).toHaveAttribute('aria-selected', 'true');
    });
  });
});
