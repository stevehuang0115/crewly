// @vitest-environment jsdom
/**
 * ApprovalAuditLog Component Tests
 *
 * @module components/Security/ApprovalAuditLog.test
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalAuditLog } from './ApprovalAuditLog';
import type { ApprovalEvent } from '../../hooks/useApprovalLog';

const mockEvents: ApprovalEvent[] = [
  {
    id: 'ev-1',
    timestamp: '2026-03-17T13:24:01.000Z',
    sessionName: 'agent-sam',
    agentName: 'Sam',
    toolName: 'git push origin feat/auth',
    outcome: 'approved',
    riskLevel: 'medium',
  },
  {
    id: 'ev-2',
    timestamp: '2026-03-17T13:22:48.000Z',
    sessionName: 'agent-sam',
    agentName: 'Sam',
    toolName: 'npm install jsonwebtoken',
    outcome: 'auto',
    riskLevel: 'low',
  },
  {
    id: 'ev-3',
    timestamp: '2026-03-17T13:19:33.000Z',
    sessionName: 'agent-leo',
    agentName: 'Leo',
    toolName: 'rm -rf dist/',
    outcome: 'denied',
    riskLevel: 'high',
    reason: 'Destructive operation',
  },
  {
    id: 'ev-4',
    timestamp: '2026-03-17T13:08:44.000Z',
    sessionName: 'agent-leo',
    agentName: 'Leo',
    toolName: 'git commit -m "feat: ..."',
    outcome: 'sop_block',
    riskLevel: 'medium',
    reason: 'Commit does not follow project SOP',
  },
];

const defaultProps = {
  events: mockEvents,
  filter: {},
  onFilterChange: vi.fn(),
  loading: false,
};

describe('ApprovalAuditLog', () => {
  it('should render section heading', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    expect(screen.getByText('Approval Audit Log')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<ApprovalAuditLog {...defaultProps} loading={true} />);
    expect(screen.getByText('Loading audit events...')).toBeInTheDocument();
  });

  it('should show empty state', () => {
    render(<ApprovalAuditLog {...defaultProps} events={[]} />);
    expect(screen.getByText('No approval events recorded')).toBeInTheDocument();
  });

  it('should render event rows', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    expect(screen.getByText('git push origin feat/auth')).toBeInTheDocument();
    expect(screen.getByText('npm install jsonwebtoken')).toBeInTheDocument();
    expect(screen.getByText('rm -rf dist/')).toBeInTheDocument();
  });

  it('should render outcome badges correctly', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.getByText('SOP Block')).toBeInTheDocument();
  });

  it('should show agent names', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    // Sam appears twice, Leo appears twice
    const samCells = screen.getAllByText('Sam');
    expect(samCells.length).toBe(2);
  });

  it('should show reason for denied/blocked events', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    expect(screen.getByText('Destructive operation')).toBeInTheDocument();
    expect(screen.getByText('Commit does not follow project SOP')).toBeInTheDocument();
  });

  it('should toggle filter menu', () => {
    render(<ApprovalAuditLog {...defaultProps} />);

    const filterButton = screen.getByTestId('filter-button');
    expect(screen.queryByTestId('filter-menu')).not.toBeInTheDocument();

    fireEvent.click(filterButton);
    expect(screen.getByTestId('filter-menu')).toBeInTheDocument();

    fireEvent.click(filterButton);
    expect(screen.queryByTestId('filter-menu')).not.toBeInTheDocument();
  });

  it('should call onFilterChange when agent filter selected', () => {
    const onFilterChange = vi.fn();
    render(<ApprovalAuditLog {...defaultProps} onFilterChange={onFilterChange} />);

    fireEvent.click(screen.getByTestId('filter-button'));
    // "Sam" appears in both table and filter menu — target the menuitem role
    const menuItems = screen.getAllByRole('menuitem');
    const samMenuItem = menuItems.find((el) => el.textContent === 'Sam');
    expect(samMenuItem).toBeDefined();
    fireEvent.click(samMenuItem!);

    expect(onFilterChange).toHaveBeenCalledWith({ agent: 'Sam' });
  });

  it('should toggle collapse/expand', () => {
    render(<ApprovalAuditLog {...defaultProps} />);

    // Initially expanded
    expect(screen.getByText('git push origin feat/auth')).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByText('Approval Audit Log'));
    expect(screen.queryByText('git push origin feat/auth')).not.toBeInTheDocument();
  });

  it('should have proper table semantics', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Tool / Command')).toBeInTheDocument();
    expect(screen.getByText('Outcome')).toBeInTheDocument();
  });

  it('should have export button', () => {
    render(<ApprovalAuditLog {...defaultProps} />);
    expect(screen.getByTestId('export-button')).toBeInTheDocument();
  });
});
