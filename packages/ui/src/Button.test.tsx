/**
 * Tests for Button and IconButton components.
 *
 * Covers rendering, variants, sizes, icons, loading states,
 * disabled states, and event handling.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from './Button';

describe('Button Component', () => {
  describe('Basic Rendering', () => {
    it('should render button with text', () => {
      render(<Button>Click me</Button>);

      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.getByText('Click me')).toBeInTheDocument();
    });

    it('should apply default variant and size classes', () => {
      render(<Button>Default Button</Button>);

      const button = screen.getByRole('button');
      // Default variant is primary, default size is default
      expect(button).toHaveClass('bg-primary', 'text-white');
      expect(button).toHaveClass('h-10', 'px-4', 'rounded-2xl');
    });

    it('should apply custom className', () => {
      render(<Button className="custom-class">Custom Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('custom-class');
    });

    it('should apply base classes', () => {
      render(<Button>Base Classes Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('font-semibold', 'flex', 'items-center', 'justify-center', 'gap-2');
    });
  });

  describe('Variants', () => {
    it('should render primary variant correctly', () => {
      render(<Button variant="primary">Primary Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-primary', 'text-white');
    });

    it('should render secondary variant correctly', () => {
      render(<Button variant="secondary">Secondary Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-surface-dark', 'border', 'border-border-dark');
    });

    it('should render success variant correctly', () => {
      render(<Button variant="success">Success Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-emerald-600', 'text-white');
    });

    it('should render warning variant correctly', () => {
      render(<Button variant="warning">Warning Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-yellow-500', 'text-black');
    });

    it('should render danger variant correctly', () => {
      render(<Button variant="danger">Danger Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-rose-600', 'text-white');
    });

    it('should render ghost variant correctly', () => {
      render(<Button variant="ghost">Ghost Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-text-secondary-dark');
    });

    it('should render outline variant correctly', () => {
      render(<Button variant="outline">Outline Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('border', 'border-border-dark', 'text-text-secondary-dark');
    });
  });

  describe('Sizes', () => {
    it('should render default size correctly', () => {
      render(<Button size="default">Default Size Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-10', 'px-4', 'rounded-2xl', 'text-sm');
    });

    it('should render sm size correctly', () => {
      render(<Button size="sm">Small Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9', 'px-3', 'rounded-2xl', 'text-sm');
    });

    it('should render icon size correctly', () => {
      render(<Button size="icon">Icon Size Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-10', 'w-10', 'rounded-2xl');
    });
  });

  describe('Icons', () => {
    it('should render icon on the left by default', () => {
      render(
        <Button icon={Plus}>
          Add Item
        </Button>
      );

      const button = screen.getByRole('button');
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveClass('h-4', 'w-4');
    });

    it('should render icon on the right when specified', () => {
      render(
        <Button icon={Plus} iconPosition="right">
          Add Item
        </Button>
      );

      const button = screen.getByRole('button');
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
      // Icon should be after the text span
      const children = Array.from(button.children);
      const iconIndex = children.findIndex(child => child.tagName === 'svg');
      const textIndex = children.findIndex(child => child.tagName === 'SPAN');
      expect(iconIndex).toBeGreaterThan(textIndex);
    });

    it('should not render icon when loading', () => {
      render(
        <Button icon={Plus} loading>
          Loading Button
        </Button>
      );

      const button = screen.getByRole('button');
      // Should have spinner (animate-spin div) but no Plus icon
      const spinner = button.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
      // The icon should not be rendered when loading
      const icons = button.querySelectorAll('svg');
      expect(icons.length).toBe(0);
    });
  });

  describe('Loading State', () => {
    it('should render spinner when loading', () => {
      render(<Button loading>Loading Button</Button>);

      const button = screen.getByRole('button');
      const spinner = button.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
      expect(spinner).toHaveClass('rounded-full', 'h-4', 'w-4', 'border-2');
    });

    it('should disable button when loading', () => {
      render(<Button loading>Loading Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('keeps the label visible next to the spinner when loading', () => {
      render(<Button loading>Loading Button</Button>);

      const button = screen.getByRole('button');
      const textSpan = button.querySelector('span');
      expect(textSpan).toBeInTheDocument();
      expect(textSpan).not.toHaveClass('opacity-0');
      expect(textSpan).toHaveTextContent('Loading Button');
    });

    it('should apply normal text class when not loading', () => {
      render(<Button>Normal Button</Button>);

      const button = screen.getByRole('button');
      const textSpan = button.querySelector('span');
      expect(textSpan).toBeInTheDocument();
      expect(textSpan).not.toHaveClass('opacity-0');
      expect(textSpan).toHaveTextContent('Normal Button');
    });
  });

  describe('Disabled State', () => {
    it('should disable button when disabled prop is true', () => {
      render(<Button disabled>Disabled Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('should disable button when loading even if disabled is false', () => {
      render(<Button disabled={false} loading>Loading Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('should apply disabled styling classes', () => {
      render(<Button disabled>Disabled Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('disabled:opacity-50', 'disabled:cursor-not-allowed');
    });
  });

  describe('Full Width', () => {
    it('should apply full width class when fullWidth is true', () => {
      render(<Button fullWidth>Full Width Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-full');
    });

    it('should not apply full width class by default', () => {
      render(<Button>Normal Button</Button>);

      const button = screen.getByRole('button');
      expect(button).not.toHaveClass('w-full');
    });
  });

  describe('Event Handling', () => {
    it('should call onClick handler when clicked', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click me</Button>);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should not call onClick when button is disabled', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick} disabled>Disabled Button</Button>);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(handleClick).not.toHaveBeenCalled();
    });

    it('should not call onClick when button is loading', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick} loading>Loading Button</Button>);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(handleClick).not.toHaveBeenCalled();
    });

    it('should support other event handlers', () => {
      const handleMouseOver = vi.fn();
      const handleFocus = vi.fn();

      render(
        <Button onMouseOver={handleMouseOver} onFocus={handleFocus}>
          Interactive Button
        </Button>
      );

      const button = screen.getByRole('button');

      fireEvent.mouseOver(button);
      expect(handleMouseOver).toHaveBeenCalledTimes(1);

      fireEvent.focus(button);
      expect(handleFocus).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTML Attributes', () => {
    it('should pass through other HTML attributes', () => {
      render(
        <Button
          type="submit"
          id="custom-button"
          data-testid="test-button"
          aria-label="Custom button"
        >
          Custom Button
        </Button>
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('type', 'submit');
      expect(button).toHaveAttribute('id', 'custom-button');
      expect(button).toHaveAttribute('data-testid', 'test-button');
      expect(button).toHaveAttribute('aria-label', 'Custom button');
    });
  });

  describe('Complex Combinations', () => {
    it('should handle multiple props correctly', () => {
      render(
        <Button
          variant="success"
          icon={Plus}
          iconPosition="right"
          fullWidth
          className="custom-class"
        >
          Complex Button
        </Button>
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-emerald-600', 'text-white');
      expect(button).toHaveClass('w-full');
      expect(button).toHaveClass('custom-class');
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('should prioritize loading state over other states', () => {
      render(
        <Button
          variant="primary"
          icon={Plus}
          loading
          disabled={false}
        >
          Loading Priority Button
        </Button>
      );

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button.querySelector('.animate-spin')).toBeInTheDocument();
      // Icon should not be rendered when loading
      const icons = button.querySelectorAll('svg');
      expect(icons.length).toBe(0);
    });
  });
});

describe('IconButton Component', () => {
  describe('Basic Rendering', () => {
    it('should render icon button with icon', () => {
      render(<IconButton icon={Plus} aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-label', 'Add item');
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('should apply default ghost variant', () => {
      render(<IconButton icon={Plus} aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('text-text-secondary-dark');
    });

    it('should apply custom variant', () => {
      render(<IconButton icon={Plus} variant="primary" aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-primary', 'text-white');
    });

    it('should apply default icon size', () => {
      render(<IconButton icon={Plus} aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-10', 'w-10', 'rounded-2xl');
    });

    it('should apply custom size', () => {
      render(<IconButton icon={Plus} size="sm" aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9', 'px-3');
    });
  });

  describe('Icon Rendering', () => {
    it('should render the provided icon', () => {
      render(<IconButton icon={Plus} aria-label="Add item" />);

      const button = screen.getByRole('button');
      const icon = button.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });

    it('should render different icons correctly', () => {
      const { rerender } = render(<IconButton icon={Plus} aria-label="Add item" />);

      let button = screen.getByRole('button');
      expect(button.querySelector('svg')).toBeInTheDocument();

      rerender(<IconButton icon={Trash2} aria-label="Delete item" />);

      button = screen.getByRole('button');
      expect(button.querySelector('svg')).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-label', 'Delete item');
    });
  });

  describe('Accessibility', () => {
    it('should require aria-label prop', () => {
      render(<IconButton icon={Plus} aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'Add item');
    });

    it('should be focusable', () => {
      render(<IconButton icon={Plus} aria-label="Add item" />);

      const button = screen.getByRole('button');
      button.focus();
      expect(document.activeElement).toBe(button);
    });

    it('should support additional ARIA attributes', () => {
      render(
        <IconButton
          icon={Plus}
          aria-label="Add item"
          aria-expanded="false"
          aria-haspopup="true"
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveAttribute('aria-haspopup', 'true');
    });
  });

  describe('Event Handling', () => {
    it('should call onClick handler when clicked', () => {
      const handleClick = vi.fn();
      render(<IconButton icon={Plus} onClick={handleClick} aria-label="Add item" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should not call onClick when disabled', () => {
      const handleClick = vi.fn();
      render(<IconButton icon={Plus} onClick={handleClick} disabled aria-label="Add item" />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  describe('States', () => {
    it('should handle loading state', () => {
      render(<IconButton icon={Plus} loading aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('should handle disabled state', () => {
      render(<IconButton icon={Plus} disabled aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });
  });

  describe('Custom Classes', () => {
    it('should apply custom className along with icon-only class', () => {
      render(<IconButton icon={Plus} className="custom-icon-btn" aria-label="Add item" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('custom-icon-btn');
    });
  });

  describe('Button Props Inheritance', () => {
    it('should pass through other button props', () => {
      render(
        <IconButton
          icon={Plus}
          aria-label="Add item"
          type="submit"
          id="icon-button"
          data-testid="test-icon-button"
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('type', 'submit');
      expect(button).toHaveAttribute('id', 'icon-button');
      expect(button).toHaveAttribute('data-testid', 'test-icon-button');
    });
  });
});
