// @vitest-environment jsdom
/**
 * DataSovereigntyReport Component Tests
 *
 * @module components/Security/DataSovereigntyReport.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataSovereigntyReport } from './DataSovereigntyReport';
import type { StorageEntry, DataSovereigntySummary } from '../../hooks/useDataSovereignty';

const mockEntries: StorageEntry[] = [
  { path: '~/.crewly/memory/', type: 'Agent Memory', sizeBytes: 12.4 * 1024 * 1024, isExternal: false },
  { path: '~/.crewly/knowledge/', type: 'Vector Store', sizeBytes: 28.1 * 1024 * 1024, isExternal: false },
  { path: '~/.crewly/sessions/', type: 'PTY Logs', sizeBytes: 7.7 * 1024 * 1024, isExternal: false },
];

const mockSummary: DataSovereigntySummary = {
  totalLocalBytes: 48.2 * 1024 * 1024,
  externalConnections: 0,
  cloudSync: 'disabled',
  status: 'secure',
  lastScan: '2026-03-17T13:25:00.000Z',
};

const defaultProps = {
  entries: mockEntries,
  summary: mockSummary,
  loading: false,
};

describe('DataSovereigntyReport', () => {
  it('should render section heading', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    expect(screen.getByText('Data Sovereignty Report')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<DataSovereigntyReport {...defaultProps} loading={true} />);
    expect(screen.getByText('Loading storage data...')).toBeInTheDocument();
  });

  it('should render storage entries', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    expect(screen.getByText('~/.crewly/memory/')).toBeInTheDocument();
    expect(screen.getByText('~/.crewly/knowledge/')).toBeInTheDocument();
    expect(screen.getByText('~/.crewly/sessions/')).toBeInTheDocument();
  });

  it('should show storage types', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    expect(screen.getByText('Agent Memory')).toBeInTheDocument();
    expect(screen.getByText('Vector Store')).toBeInTheDocument();
    expect(screen.getByText('PTY Logs')).toBeInTheDocument();
  });

  it('should show external status for each entry', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    const noLabels = screen.getAllByLabelText('External: No');
    expect(noLabels.length).toBe(3);
  });

  it('should show summary footer', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    expect(screen.getByText(/Total local storage:/)).toBeInTheDocument();
    expect(screen.getByText(/External connections:/)).toBeInTheDocument();
    expect(screen.getByText(/Cloud sync:/)).toBeInTheDocument();
  });

  it('should show SECURE status badge', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    expect(screen.getByTestId('sovereignty-status')).toHaveTextContent('SECURE');
  });

  it('should show WARNING status when applicable', () => {
    const warningSummary = { ...mockSummary, status: 'warning' as const };
    render(<DataSovereigntyReport {...defaultProps} summary={warningSummary} />);
    expect(screen.getByTestId('sovereignty-status')).toHaveTextContent('WARNING');
  });

  it('should toggle collapse/expand', () => {
    render(<DataSovereigntyReport {...defaultProps} />);

    // Initially expanded
    expect(screen.getByText('~/.crewly/memory/')).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByText('Data Sovereignty Report'));
    expect(screen.queryByText('~/.crewly/memory/')).not.toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByText('Data Sovereignty Report'));
    expect(screen.getByText('~/.crewly/memory/')).toBeInTheDocument();
  });

  it('should have proper table semantics', () => {
    render(<DataSovereigntyReport {...defaultProps} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Storage Location')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('External?')).toBeInTheDocument();
  });

  it('should show external entries with red indicator', () => {
    const entriesWithExternal: StorageEntry[] = [
      ...mockEntries,
      { path: 'cloud://sync', type: 'Cloud Backup', sizeBytes: 5000000, isExternal: true },
    ];
    render(<DataSovereigntyReport entries={entriesWithExternal} summary={mockSummary} loading={false} />);
    expect(screen.getByLabelText('External: Yes')).toBeInTheDocument();
  });
});
