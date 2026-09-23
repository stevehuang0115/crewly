/**
 * Alert Component Tests
 *
 * @module components/UI/Alert.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Alert } from './Alert';

describe('Alert', () => {
  describe('Rendering', () => {
    it('should render children', () => {
      render(<Alert>Alert message</Alert>);
      expect(screen.getByText('Alert message')).toBeInTheDocument();
    });

    it('should have alert role', () => {
      render(<Alert>Message</Alert>);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should render title when provided', () => {
      render(<Alert title="Alert Title">Message</Alert>);
      expect(screen.getByText('Alert Title')).toBeInTheDocument();
    });
  });

  describe('Variants', () => {
    it('should apply info variant by default', () => {
      render(<Alert>Info message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-blue-400');
    });

    it('should apply info variant classes', () => {
      render(<Alert variant="info">Info message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-blue-400');
    });

    it('should apply success variant classes', () => {
      render(<Alert variant="success">Success message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-emerald-400');
    });

    it('should apply warning variant classes', () => {
      render(<Alert variant="warning">Warning message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-yellow-400');
    });

    it('should apply error variant classes', () => {
      render(<Alert variant="error">Error message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('text-red-400');
    });
  });

  describe('Close button', () => {
    it('should not render close button by default', () => {
      render(<Alert>Message</Alert>);
      expect(screen.queryByLabelText('Dismiss alert')).not.toBeInTheDocument();
    });

    it('should render close button when onClose is provided', () => {
      const handleClose = vi.fn();
      render(<Alert onClose={handleClose}>Message</Alert>);
      expect(screen.getByLabelText('Dismiss alert')).toBeInTheDocument();
    });

    it('should call onClose when close button is clicked', () => {
      const handleClose = vi.fn();
      render(<Alert onClose={handleClose}>Message</Alert>);
      fireEvent.click(screen.getByLabelText('Dismiss alert'));
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Icon', () => {
    it('should render icon with aria-hidden', () => {
      const { container } = render(<Alert>Message</Alert>);
      const icon = container.querySelector('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('Title', () => {
    it('should render title with proper styling', () => {
      render(<Alert title="Important">Message</Alert>);
      const title = screen.getByText('Important');
      expect(title.tagName).toBe('H4');
      expect(title).toHaveClass('font-medium');
    });
  });

  describe('Styling', () => {
    it('should have a rounded border', () => {
      render(<Alert>Message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('rounded-2xl');
    });

    it('should have proper padding', () => {
      render(<Alert>Message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('p-4');
    });

    it('should use flexbox layout', () => {
      render(<Alert>Message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('flex');
      expect(alert).toHaveClass('items-start');
    });
  });

  describe('Custom className', () => {
    it('should merge custom className with default classes', () => {
      render(<Alert className="custom-alert">Message</Alert>);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveClass('custom-alert');
      expect(alert).toHaveClass('rounded-2xl');
    });
  });

  describe('Complex children', () => {
    it('should render complex content', () => {
      render(
        <Alert>
          <p data-testid="paragraph">First line</p>
          <ul>
            <li data-testid="list-item">Item 1</li>
          </ul>
        </Alert>
      );
      expect(screen.getByTestId('paragraph')).toBeInTheDocument();
      expect(screen.getByTestId('list-item')).toBeInTheDocument();
    });
  });
});
