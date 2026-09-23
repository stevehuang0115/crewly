/**
 * Badge Component Tests
 *
 * @module components/UI/Badge.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  describe('Rendering', () => {
    it('should render children', () => {
      render(<Badge>Active</Badge>);
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('should render as a span element', () => {
      const { container } = render(<Badge>Status</Badge>);
      expect(container.firstChild?.nodeName).toBe('SPAN');
    });
  });

  describe('Variants', () => {
    it('should apply default variant classes', () => {
      const { container } = render(<Badge variant="default">Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('bg-background-dark');
      expect(badge).toHaveClass('text-text-secondary-dark');
    });

    it('should apply primary variant classes', () => {
      const { container } = render(<Badge variant="primary">Primary</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-primary');
    });

    it('should apply success variant classes', () => {
      const { container } = render(<Badge variant="success">Success</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-emerald-400');
    });

    it('should apply warning variant classes', () => {
      const { container } = render(<Badge variant="warning">Warning</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-yellow-400');
    });

    it('should apply error variant classes', () => {
      const { container } = render(<Badge variant="error">Error</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-red-400');
    });

    it('should apply info variant classes', () => {
      const { container } = render(<Badge variant="info">Info</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-blue-400');
    });
  });

  describe('Sizes', () => {
    it('should apply small size by default', () => {
      const { container } = render(<Badge>Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-xs');
      expect(badge).toHaveClass('px-2');
    });

    it('should apply small size classes', () => {
      const { container } = render(<Badge size="sm">Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-xs');
      expect(badge).toHaveClass('px-2');
    });

    it('should apply medium size classes', () => {
      const { container } = render(<Badge size="md">Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('text-sm');
      expect(badge).toHaveClass('px-2.5');
    });
  });

  describe('Styling', () => {
    it('should have rounded-full class for pill shape', () => {
      const { container } = render(<Badge>Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('rounded-full');
    });

    it('should have font-medium class', () => {
      const { container } = render(<Badge>Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('font-medium');
    });

    it('should have inline-flex and items-center for alignment', () => {
      const { container } = render(<Badge>Status</Badge>);
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('inline-flex');
      expect(badge).toHaveClass('items-center');
    });
  });

  describe('Custom className', () => {
    it('should merge custom className with default classes', () => {
      const { container } = render(
        <Badge className="custom-class">Status</Badge>
      );
      const badge = container.firstChild as HTMLElement;
      expect(badge).toHaveClass('custom-class');
      expect(badge).toHaveClass('rounded-full');
    });
  });

  describe('Complex children', () => {
    it('should render icons with text', () => {
      render(
        <Badge>
          <span data-testid="icon">*</span>
          Active
        </Badge>
      );
      expect(screen.getByTestId('icon')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
  });
});
