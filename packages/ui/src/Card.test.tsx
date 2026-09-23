/**
 * Card Component Tests
 *
 * @module components/UI/Card.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Card } from './Card';

describe('Card', () => {
  describe('Rendering', () => {
    it('should render children', () => {
      render(<Card>Card Content</Card>);
      expect(screen.getByText('Card Content')).toBeInTheDocument();
    });

    it('should render with default variant and padding', () => {
      const { container } = render(<Card>Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('bg-surface-dark');
      expect(card).toHaveClass('border');
      expect(card).toHaveClass('p-4');
    });
  });

  describe('Variants', () => {
    it('should apply default variant classes', () => {
      const { container } = render(<Card variant="default">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('bg-surface-dark');
      expect(card).toHaveClass('border-border-dark');
    });

    it('should apply outlined variant classes', () => {
      const { container } = render(<Card variant="outlined">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('bg-transparent');
      expect(card).toHaveClass('border-border-dark');
    });

    it('should apply elevated variant classes', () => {
      const { container } = render(<Card variant="elevated">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('bg-surface-dark');
      expect(card).toHaveClass('shadow-md');
    });
  });

  describe('Padding', () => {
    it('should apply no padding', () => {
      const { container } = render(<Card padding="none">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).not.toHaveClass('p-3');
      expect(card).not.toHaveClass('p-4');
      expect(card).not.toHaveClass('p-6');
    });

    it('should apply small padding', () => {
      const { container } = render(<Card padding="sm">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('p-3');
    });

    it('should apply medium padding', () => {
      const { container } = render(<Card padding="md">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('p-4');
    });

    it('should apply large padding', () => {
      const { container } = render(<Card padding="lg">Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('p-6');
    });
  });

  describe('Interactive', () => {
    it('should apply interactive classes when interactive prop is true', () => {
      const { container } = render(<Card interactive>Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('cursor-pointer');
      expect(card).toHaveClass('transition-colors');
    });

    it('should not apply interactive classes by default', () => {
      const { container } = render(<Card>Content</Card>);
      const card = container.firstChild as HTMLElement;
      expect(card).not.toHaveClass('cursor-pointer');
    });

    it('should respond to click events when interactive', () => {
      const handleClick = vi.fn();
      render(
        <Card interactive onClick={handleClick}>
          Content
        </Card>
      );
      fireEvent.click(screen.getByText('Content'));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Custom className', () => {
    it('should merge custom className with default classes', () => {
      const { container } = render(
        <Card className="custom-class">Content</Card>
      );
      const card = container.firstChild as HTMLElement;
      expect(card).toHaveClass('custom-class');
      expect(card).toHaveClass('rounded-2xl');
    });
  });

  describe('Ref forwarding', () => {
    it('should forward ref to the div element', () => {
      const ref = React.createRef<HTMLDivElement>();
      render(<Card ref={ref}>Content</Card>);
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });
  });

  describe('Props spreading', () => {
    it('should pass through HTML attributes', () => {
      render(
        <Card data-testid="test-card" id="my-card">
          Content
        </Card>
      );
      const card = screen.getByTestId('test-card');
      expect(card).toHaveAttribute('id', 'my-card');
    });
  });
});
