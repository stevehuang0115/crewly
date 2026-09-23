/**
 * StatusDot Component Tests
 *
 * @module components/UI/StatusDot.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatusDot } from './StatusDot';
import type { DotStatus, DotSize } from './StatusDot';

describe('StatusDot', () => {
  // =========================================================================
  // Color mapping
  // =========================================================================

  describe('status → color mapping', () => {
    const greenStatuses: DotStatus[] = ['active', 'online', 'paired'];
    const yellowStatuses: DotStatus[] = ['waiting', 'connecting'];
    const grayStatuses: DotStatus[] = ['inactive', 'disconnected', 'offline'];

    it.each(greenStatuses)('maps "%s" to emerald-400', (status) => {
      render(<StatusDot status={status} />);
      expect(screen.getByTestId('status-dot')).toHaveClass('bg-emerald-400');
    });

    it.each(yellowStatuses)('maps "%s" to yellow-400', (status) => {
      render(<StatusDot status={status} />);
      expect(screen.getByTestId('status-dot')).toHaveClass('bg-yellow-400');
    });

    it.each(grayStatuses)('maps "%s" to gray-500', (status) => {
      render(<StatusDot status={status} />);
      expect(screen.getByTestId('status-dot')).toHaveClass('bg-gray-500');
    });

    it('maps "error" to rose-400', () => {
      render(<StatusDot status="error" />);
      expect(screen.getByTestId('status-dot')).toHaveClass('bg-rose-400');
    });
  });

  // =========================================================================
  // Sizes
  // =========================================================================

  describe('size classes', () => {
    const sizeExpectations: [DotSize, string][] = [
      ['sm', 'h-2 w-2'],
      ['md', 'h-2.5 w-2.5'],
      ['lg', 'h-3 w-3'],
    ];

    it.each(sizeExpectations)('size="%s" applies %s', (size, expectedClasses) => {
      render(<StatusDot status="active" size={size} />);
      const dot = screen.getByTestId('status-dot');
      for (const cls of expectedClasses.split(' ')) {
        expect(dot).toHaveClass(cls);
      }
    });

    it('defaults to "md" size', () => {
      render(<StatusDot status="active" />);
      const dot = screen.getByTestId('status-dot');
      expect(dot).toHaveClass('h-2.5');
      expect(dot).toHaveClass('w-2.5');
    });
  });

  // =========================================================================
  // Pulse behavior
  // =========================================================================

  describe('pulse behavior', () => {
    it('pulses by default for "active"', () => {
      render(<StatusDot status="active" />);
      expect(screen.getByTestId('status-dot')).toHaveClass('animate-pulse');
    });

    it('pulses by default for "online"', () => {
      render(<StatusDot status="online" />);
      expect(screen.getByTestId('status-dot')).toHaveClass('animate-pulse');
    });

    it('pulses by default for "connecting"', () => {
      render(<StatusDot status="connecting" />);
      expect(screen.getByTestId('status-dot')).toHaveClass('animate-pulse');
    });

    it('does NOT pulse by default for "inactive"', () => {
      render(<StatusDot status="inactive" />);
      expect(screen.getByTestId('status-dot')).not.toHaveClass('animate-pulse');
    });

    it('does NOT pulse by default for "error"', () => {
      render(<StatusDot status="error" />);
      expect(screen.getByTestId('status-dot')).not.toHaveClass('animate-pulse');
    });

    it('does NOT pulse by default for "offline"', () => {
      render(<StatusDot status="offline" />);
      expect(screen.getByTestId('status-dot')).not.toHaveClass('animate-pulse');
    });

    it('respects pulse=true override for normally non-pulsing status', () => {
      render(<StatusDot status="error" pulse={true} />);
      expect(screen.getByTestId('status-dot')).toHaveClass('animate-pulse');
    });

    it('respects pulse=false override for normally pulsing status', () => {
      render(<StatusDot status="active" pulse={false} />);
      expect(screen.getByTestId('status-dot')).not.toHaveClass('animate-pulse');
    });
  });

  // =========================================================================
  // Rendering basics
  // =========================================================================

  describe('rendering', () => {
    it('renders as rounded-full span', () => {
      render(<StatusDot status="active" />);
      const dot = screen.getByTestId('status-dot');
      expect(dot.tagName).toBe('SPAN');
      expect(dot).toHaveClass('rounded-full');
    });

    it('has role="status"', () => {
      render(<StatusDot status="active" />);
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('has aria-label matching status', () => {
      render(<StatusDot status="connecting" />);
      expect(screen.getByTestId('status-dot')).toHaveAttribute('aria-label', 'connecting');
    });

    it('merges custom className', () => {
      render(<StatusDot status="active" className="ml-2" />);
      expect(screen.getByTestId('status-dot')).toHaveClass('ml-2');
    });
  });
});
