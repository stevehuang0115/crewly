// @vitest-environment jsdom
/**
 * Tests for SecurityArchDiagram component
 *
 * Verifies the 3-state interactive architecture diagram renders the
 * correct state based on activePillar prop, and meets accessibility
 * requirements per spec section 2.3 and 6.
 *
 * @module components/Security/SecurityArchDiagram.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SecurityArchDiagram } from './SecurityArchDiagram';

describe('SecurityArchDiagram', () => {
  describe('common rendering', () => {
    it('should render with correct testid', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      expect(screen.getByTestId('security-arch-diagram')).toBeDefined();
    });

    it('should have role="img" for accessibility', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('role')).toBe('img');
    });

    it('should have descriptive aria-label', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('aria-label')).toContain('PTY Isolation');
    });

    it('should have id for aria-controls linkage', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('id')).toBe('security-arch-diagram');
    });

    it('should show "Your Machine" label', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      expect(screen.getByText('Your Machine')).toBeDefined();
    });
  });

  describe('State A — PTY Isolation', () => {
    it('should render three PTY agent boxes', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      expect(screen.getByTestId('pty-agent-sam')).toBeDefined();
      expect(screen.getByTestId('pty-agent-leo')).toBeDefined();
      expect(screen.getByTestId('pty-agent-ava')).toBeDefined();
    });

    it('should display agent names and roles', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      expect(screen.getByText('Sam')).toBeDefined();
      expect(screen.getByText('(TL)')).toBeDefined();
      expect(screen.getByText('Leo')).toBeDefined();
      expect(screen.getByText('(Dev)')).toBeDefined();
    });

    it('should show blocked attack path indicator', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      expect(screen.getByText(/BLOCKED/)).toBeDefined();
    });

    it('should update aria-label for PTY state', () => {
      render(<SecurityArchDiagram activePillar="pty" />);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('aria-label')).toContain('isolated pseudo-terminal');
    });
  });

  describe('State B — Local Vector Storage', () => {
    it('should render storage categories', () => {
      render(<SecurityArchDiagram activePillar="storage" />);
      expect(screen.getByText('Agent Memory')).toBeDefined();
      expect(screen.getByText('Conversations')).toBeDefined();
      expect(screen.getByText('Project Knowl.')).toBeDefined();
    });

    it('should show no cloud connection indicator', () => {
      render(<SecurityArchDiagram activePillar="storage" />);
      expect(screen.getByText(/NO CONNECTION/)).toBeDefined();
    });

    it('should show data sovereignty quote', () => {
      render(<SecurityArchDiagram activePillar="storage" />);
      expect(screen.getByText(/never leave this machine/)).toBeDefined();
    });

    it('should update aria-label for storage state', () => {
      render(<SecurityArchDiagram activePillar="storage" />);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('aria-label')).toContain('stored locally');
    });
  });

  describe('State C — Granular Tool Approval', () => {
    it('should render the approval prompt', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      expect(screen.getByText(/git push --force origin main/)).toBeDefined();
    });

    it('should show risk level HIGH', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      expect(screen.getByText('HIGH')).toBeDefined();
    });

    it('should render Deny and Approve buttons', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      expect(screen.getByRole('button', { name: /deny/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
    });

    it('should show denied message after clicking Deny', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      fireEvent.click(screen.getByRole('button', { name: /deny/i }));
      expect(screen.getByText(/denied/i)).toBeDefined();
    });

    it('should show approved message after clicking Approve', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      fireEvent.click(screen.getByRole('button', { name: /approve/i }));
      expect(screen.getByRole('status').textContent).toContain('proceeding');
    });

    it('should render the permission matrix with all rows', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      expect(screen.getByText('read files')).toBeDefined();
      expect(screen.getByText('write files')).toBeDefined();
      expect(screen.getByText('npm install')).toBeDefined();
      expect(screen.getByText('git push --force')).toBeDefined();
      expect(screen.getByText('rm -rf')).toBeDefined();
    });

    it('should render permission levels correctly', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      const autoApproved = screen.getAllByText('Auto-approved');
      expect(autoApproved.length).toBe(2);
      expect(screen.getByText('Ask once')).toBeDefined();
      const alwaysAsk = screen.getAllByText('Always ask');
      expect(alwaysAsk.length).toBe(2);
    });

    it('should have accessible permission matrix', () => {
      render(<SecurityArchDiagram activePillar="approval" />);
      expect(screen.getByRole('list', { name: /permission matrix/i })).toBeDefined();
    });
  });
});
