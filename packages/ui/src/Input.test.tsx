/**
 * Input Component Tests
 *
 * @module components/UI/Input.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  describe('Rendering', () => {
    it('should render an input element', () => {
      render(<Input placeholder="Enter text" />);
      expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
    });

    it('should render with default classes', () => {
      const { container } = render(<Input />);
      const input = container.querySelector('input');
      expect(input).toHaveClass('bg-background-dark');
      expect(input).toHaveClass('border-border-dark');
      expect(input).toHaveClass('rounded-2xl');
    });
  });

  describe('Label', () => {
    it('should render label when provided', () => {
      render(<Input label="Email" name="email" />);
      expect(screen.getByText('Email')).toBeInTheDocument();
    });

    it('should associate label with input via htmlFor', () => {
      render(<Input label="Email" name="email" />);
      const label = screen.getByText('Email');
      const input = screen.getByRole('textbox');
      expect(label).toHaveAttribute('for', 'email');
      expect(input).toHaveAttribute('id', 'email');
    });

    it('should use id prop for label association when provided', () => {
      render(<Input label="Email" id="custom-id" name="email" />);
      const label = screen.getByText('Email');
      expect(label).toHaveAttribute('for', 'custom-id');
    });

    it('should generate a stable ID when neither id nor name is provided', () => {
      render(<Input label="Field" />);
      const label = screen.getByText('Field');
      const input = screen.getByRole('textbox');
      // The generated ID should exist and match
      const labelFor = label.getAttribute('for');
      const inputId = input.getAttribute('id');
      expect(labelFor).toBeTruthy();
      expect(inputId).toBe(labelFor);
    });
  });

  describe('Error state', () => {
    it('should display error message', () => {
      render(<Input error="This field is required" name="field" />);
      expect(screen.getByText('This field is required')).toBeInTheDocument();
    });

    it('should apply error styling to input', () => {
      const { container } = render(<Input error="Error" />);
      const input = container.querySelector('input');
      expect(input).toHaveClass('border-red-500');
    });

    it('should set aria-invalid when error is present', () => {
      render(<Input error="Error" />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('should have role="alert" on error message', () => {
      render(<Input error="Error" name="field" />);
      const error = screen.getByRole('alert');
      expect(error).toHaveTextContent('Error');
    });
  });

  describe('Helper text', () => {
    it('should display helper text', () => {
      render(<Input helperText="Enter your email address" name="email" />);
      expect(screen.getByText('Enter your email address')).toBeInTheDocument();
    });

    it('should hide helper text when error is present', () => {
      render(
        <Input
          helperText="Enter your email address"
          error="Invalid email"
          name="email"
        />
      );
      expect(screen.queryByText('Enter your email address')).not.toBeInTheDocument();
      expect(screen.getByText('Invalid email')).toBeInTheDocument();
    });
  });

  describe('Full width', () => {
    it('should apply full width class when fullWidth is true', () => {
      const { container } = render(<Input fullWidth />);
      expect(container.firstChild).toHaveClass('w-full');
    });

    it('should not apply full width class by default', () => {
      const { container } = render(<Input />);
      expect(container.firstChild).not.toHaveClass('w-full');
    });
  });

  describe('Disabled state', () => {
    it('should be disabled when disabled prop is true', () => {
      render(<Input disabled />);
      expect(screen.getByRole('textbox')).toBeDisabled();
    });

    it('should apply disabled styling', () => {
      const { container } = render(<Input disabled />);
      const input = container.querySelector('input');
      expect(input).toHaveClass('disabled:opacity-50');
      expect(input).toHaveClass('disabled:cursor-not-allowed');
    });
  });

  describe('Event handling', () => {
    it('should call onChange when value changes', () => {
      const handleChange = vi.fn();
      render(<Input onChange={handleChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'test' } });
      expect(handleChange).toHaveBeenCalledTimes(1);
    });

    it('should call onFocus when focused', () => {
      const handleFocus = vi.fn();
      render(<Input onFocus={handleFocus} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      expect(handleFocus).toHaveBeenCalledTimes(1);
    });

    it('should call onBlur when blurred', () => {
      const handleBlur = vi.fn();
      render(<Input onBlur={handleBlur} />);
      const input = screen.getByRole('textbox');
      fireEvent.blur(input);
      expect(handleBlur).toHaveBeenCalledTimes(1);
    });
  });

  describe('Ref forwarding', () => {
    it('should forward ref to the input element', () => {
      const ref = React.createRef<HTMLInputElement>();
      render(<Input ref={ref} />);
      expect(ref.current).toBeInstanceOf(HTMLInputElement);
    });
  });

  describe('Props spreading', () => {
    it('should pass through input attributes', () => {
      render(<Input type="email" maxLength={50} data-testid="test-input" />);
      const input = screen.getByTestId('test-input');
      expect(input).toHaveAttribute('type', 'email');
      expect(input).toHaveAttribute('maxLength', '50');
    });
  });

  describe('Custom className', () => {
    it('should merge custom className with default classes', () => {
      const { container } = render(<Input className="custom-class" />);
      const input = container.querySelector('input');
      expect(input).toHaveClass('custom-class');
      expect(input).toHaveClass('bg-background-dark');
    });
  });
});
