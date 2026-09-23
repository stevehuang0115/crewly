/**
 * Tests for VisibilityToggles component.
 *
 * Tests cover:
 * - Component rendering
 * - Toggle button states
 * - Expansion/collapse behavior
 * - Toggle functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock the FactoryContext
const mockSetShowNPCAgents = vi.fn();
const mockSetShowGuestAgents = vi.fn();
const mockSetShowObjects = vi.fn();

let mockShowNPCAgents = true;
let mockShowGuestAgents = true;
let mockShowObjects = true;

vi.mock('../../../contexts/FactoryContext', () => ({
  useFactory: () => ({
    showNPCAgents: mockShowNPCAgents,
    setShowNPCAgents: mockSetShowNPCAgents,
    showGuestAgents: mockShowGuestAgents,
    setShowGuestAgents: mockSetShowGuestAgents,
    showObjects: mockShowObjects,
    setShowObjects: mockSetShowObjects,
  }),
}));

// Import after mocks
import { VisibilityToggles } from './VisibilityToggles';

describe('VisibilityToggles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowNPCAgents = true;
    mockShowGuestAgents = true;
    mockShowObjects = true;
  });

  describe('rendering', () => {
    it('should render the visibility button', () => {
      render(<VisibilityToggles />);
      const button = screen.getByRole('button', { name: /visibility/i });
      expect(button).toBeDefined();
    });

    it('should show "Visibility" text when all are visible', () => {
      render(<VisibilityToggles />);
      expect(screen.getByText('Visibility')).toBeDefined();
    });

    it('should show hidden count when some are hidden', () => {
      mockShowNPCAgents = false;
      render(<VisibilityToggles />);
      expect(screen.getByText('1 Hidden')).toBeDefined();
    });

    it('should show correct hidden count for multiple hidden items', () => {
      mockShowNPCAgents = false;
      mockShowGuestAgents = false;
      render(<VisibilityToggles />);
      expect(screen.getByText('2 Hidden')).toBeDefined();
    });
  });

  describe('expansion', () => {
    it('should not show toggles when collapsed', () => {
      render(<VisibilityToggles />);
      expect(screen.queryByText('NPC Agents')).toBeNull();
      expect(screen.queryByText('Guest Agents')).toBeNull();
      expect(screen.queryByText('Objects')).toBeNull();
    });

    it('should show toggles when expanded', () => {
      render(<VisibilityToggles />);
      const button = screen.getByRole('button', { name: /visibility/i });
      fireEvent.click(button);

      expect(screen.getByText('NPC Agents')).toBeDefined();
      expect(screen.getByText('Guest Agents')).toBeDefined();
      expect(screen.getByText('Objects')).toBeDefined();
    });
  });

  describe('toggle functionality', () => {
    it('should have three toggles in the expanded panel', () => {
      render(<VisibilityToggles />);
      const mainButton = screen.getByRole('button', { name: /visibility/i });
      fireEvent.click(mainButton);

      // Each toggle is a switch inside the panel (role="switch")
      expect(screen.getAllByRole('switch')).toHaveLength(3);
      // Plus the main button and the collapse button
      expect(screen.getAllByRole('button')).toHaveLength(2);
    });
  });

  describe('toggle configurations', () => {
    it('should have correct labels for each toggle', () => {
      render(<VisibilityToggles />);
      const button = screen.getByRole('button', { name: /visibility/i });
      fireEvent.click(button);

      expect(screen.getByText('NPC Agents')).toBeDefined();
      expect(screen.getByText('Guest Agents')).toBeDefined();
      expect(screen.getByText('Objects')).toBeDefined();
    });
  });
});
