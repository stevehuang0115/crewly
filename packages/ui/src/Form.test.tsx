/**
 * Tests for Form components.
 *
 * Covers Form, FormGroup, FormRow, FormLabel, FormHelp, FormError,
 * FormInput, FormTextarea, and FormSection components.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import {
  Form,
  FormGroup,
  FormRow,
  FormLabel,
  FormHelp,
  FormError,
  FormInput,
  FormTextarea,
  FormSection
} from './Form';

describe('Form Component', () => {
  describe('Basic Rendering', () => {
    it('should render form with children', () => {
      const { container } = render(
        <Form>
          <div>Form content</div>
        </Form>
      );

      const form = container.querySelector('form');
      expect(form).toBeInTheDocument();
      expect(screen.getByText('Form content')).toBeInTheDocument();
    });

    it('should apply form class by default', () => {
      const { container } = render(
        <Form>
          <div>Content</div>
        </Form>
      );

      const form = container.querySelector('form');
      expect(form).toHaveClass('form');
    });

    it('should apply custom className', () => {
      const { container } = render(
        <Form className="custom-form">
          <div>Content</div>
        </Form>
      );

      const form = container.querySelector('form');
      expect(form).toHaveClass('form', 'custom-form');
    });

    it('should pass through form attributes', () => {
      const handleSubmit = vi.fn((e) => e.preventDefault());

      const { container } = render(
        <Form onSubmit={handleSubmit} method="post" action="/submit">
          <button type="submit">Submit</button>
        </Form>
      );

      const form = container.querySelector('form');
      expect(form).toHaveAttribute('method', 'post');
      expect(form).toHaveAttribute('action', '/submit');

      fireEvent.submit(form!);
      expect(handleSubmit).toHaveBeenCalledTimes(1);
    });
  });
});

describe('FormGroup Component', () => {
  describe('Basic Rendering', () => {
    it('should render form group with children', () => {
      render(
        <FormGroup>
          <div>Group content</div>
        </FormGroup>
      );

      expect(screen.getByText('Group content')).toBeInTheDocument();
    });

    it('should apply form-group class by default', () => {
      render(
        <FormGroup>
          <div>Content</div>
        </FormGroup>
      );

      const group = document.querySelector('.form-group');
      expect(group).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(
        <FormGroup className="custom-group">
          <div>Content</div>
        </FormGroup>
      );

      const group = document.querySelector('.form-group');
      expect(group).toHaveClass('form-group', 'custom-group');
    });
  });
});

describe('FormRow Component', () => {
  describe('Basic Rendering', () => {
    it('should render form row with children', () => {
      render(
        <FormRow>
          <div>Row content</div>
        </FormRow>
      );

      expect(screen.getByText('Row content')).toBeInTheDocument();
    });

    it('should apply form-row class by default', () => {
      render(
        <FormRow>
          <div>Content</div>
        </FormRow>
      );

      const row = document.querySelector('.form-row');
      expect(row).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(
        <FormRow className="custom-row">
          <div>Content</div>
        </FormRow>
      );

      const row = document.querySelector('.form-row');
      expect(row).toHaveClass('form-row', 'custom-row');
    });
  });
});

describe('FormLabel Component', () => {
  describe('Basic Rendering', () => {
    it('should render label with text', () => {
      render(<FormLabel>Test Label</FormLabel>);

      const label = screen.getByText('Test Label');
      expect(label).toBeInTheDocument();
      expect(label.tagName).toBe('LABEL');
    });

    it('should apply Tailwind styling classes by default', () => {
      render(<FormLabel>Test Label</FormLabel>);

      const label = screen.getByText('Test Label');
      expect(label).toHaveClass('block', 'text-sm', 'font-medium', 'text-text-primary-dark', 'mb-2');
    });

    it('should apply custom className', () => {
      render(<FormLabel className="custom-label">Test Label</FormLabel>);

      const label = screen.getByText('Test Label');
      expect(label).toHaveClass('custom-label');
    });

    it('should pass through label attributes', () => {
      render(<FormLabel htmlFor="test-input">Test Label</FormLabel>);

      const label = screen.getByText('Test Label');
      expect(label).toHaveAttribute('for', 'test-input');
    });
  });

  describe('Required Indicator', () => {
    it('should show required asterisk when required is true', () => {
      render(<FormLabel required>Required Label</FormLabel>);

      expect(screen.getByText('Required Label')).toBeInTheDocument();
      expect(screen.getByText('*')).toBeInTheDocument();
      expect(screen.getByText('*')).toHaveClass('text-red-500', 'ml-1');
    });

    it('should not show required asterisk by default', () => {
      render(<FormLabel>Normal Label</FormLabel>);

      expect(screen.getByText('Normal Label')).toBeInTheDocument();
      expect(screen.queryByText('*')).not.toBeInTheDocument();
    });

    it('should not show required asterisk when required is false', () => {
      render(<FormLabel required={false}>Optional Label</FormLabel>);

      expect(screen.getByText('Optional Label')).toBeInTheDocument();
      expect(screen.queryByText('*')).not.toBeInTheDocument();
    });
  });
});

describe('FormHelp Component', () => {
  describe('Basic Rendering', () => {
    it('should render help text', () => {
      render(<FormHelp>This is help text</FormHelp>);

      const help = screen.getByText('This is help text');
      expect(help).toBeInTheDocument();
      expect(help.tagName).toBe('SMALL');
    });

    it('should apply form-help class by default', () => {
      render(<FormHelp>Help text</FormHelp>);

      const help = screen.getByText('Help text');
      expect(help).toHaveClass('form-help');
    });

    it('should apply custom className', () => {
      render(<FormHelp className="custom-help">Help text</FormHelp>);

      const help = screen.getByText('Help text');
      expect(help).toHaveClass('form-help', 'custom-help');
    });
  });
});

describe('FormError Component', () => {
  describe('Basic Rendering', () => {
    it('should render error text', () => {
      render(<FormError>This is an error</FormError>);

      const error = screen.getByText('This is an error');
      expect(error).toBeInTheDocument();
      expect(error.tagName).toBe('DIV');
    });

    it('should apply form-error class by default', () => {
      render(<FormError>Error text</FormError>);

      const error = screen.getByText('Error text');
      expect(error).toHaveClass('form-error');
    });

    it('should apply custom className', () => {
      render(<FormError className="custom-error">Error text</FormError>);

      const error = screen.getByText('Error text');
      expect(error).toHaveClass('form-error', 'custom-error');
    });
  });
});

describe('FormInput Component', () => {
  describe('Basic Rendering', () => {
    it('should render input element', () => {
      render(<FormInput placeholder="Test input" />);

      const input = screen.getByPlaceholderText('Test input');
      expect(input).toBeInTheDocument();
      expect(input.tagName).toBe('INPUT');
    });

    it('should apply Tailwind styling classes by default', () => {
      render(<FormInput placeholder="Test input" />);

      const input = screen.getByPlaceholderText('Test input');
      expect(input).toHaveClass('w-full', 'bg-background-dark', 'border', 'border-border-dark', 'rounded-2xl');
    });

    it('should apply custom className', () => {
      render(<FormInput placeholder="Test input" className="custom-input" />);

      const input = screen.getByPlaceholderText('Test input');
      expect(input).toHaveClass('custom-input');
    });

    it('should pass through input attributes', () => {
      render(
        <FormInput
          type="email"
          placeholder="Enter email"
          required
          id="email-input"
        />
      );

      const input = screen.getByPlaceholderText('Enter email');
      expect(input).toHaveAttribute('type', 'email');
      expect(input).toHaveAttribute('required');
      expect(input).toHaveAttribute('id', 'email-input');
    });
  });

  describe('Error State', () => {
    it('should apply error class when error is true', () => {
      render(<FormInput placeholder="Error input" error />);

      const input = screen.getByPlaceholderText('Error input');
      expect(input).toHaveClass('border-red-500');
    });

    it('should not apply error class by default', () => {
      render(<FormInput placeholder="Normal input" />);

      const input = screen.getByPlaceholderText('Normal input');
      expect(input).not.toHaveClass('border-red-500');
    });

    it('should not apply error class when error is false', () => {
      render(<FormInput placeholder="Normal input" error={false} />);

      const input = screen.getByPlaceholderText('Normal input');
      expect(input).not.toHaveClass('border-red-500');
    });
  });

  describe('Event Handling', () => {
    it('should handle change events', () => {
      const handleChange = vi.fn();
      render(<FormInput placeholder="Test input" onChange={handleChange} />);

      const input = screen.getByPlaceholderText('Test input');
      fireEvent.change(input, { target: { value: 'test value' } });

      expect(handleChange).toHaveBeenCalledTimes(1);
    });

    it('should handle focus and blur events', () => {
      const handleFocus = vi.fn();
      const handleBlur = vi.fn();
      render(
        <FormInput
          placeholder="Test input"
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
      );

      const input = screen.getByPlaceholderText('Test input');

      fireEvent.focus(input);
      expect(handleFocus).toHaveBeenCalledTimes(1);

      fireEvent.blur(input);
      expect(handleBlur).toHaveBeenCalledTimes(1);
    });
  });
});

describe('FormTextarea Component', () => {
  describe('Basic Rendering', () => {
    it('should render textarea element', () => {
      render(<FormTextarea placeholder="Test textarea" />);

      const textarea = screen.getByPlaceholderText('Test textarea');
      expect(textarea).toBeInTheDocument();
      expect(textarea.tagName).toBe('TEXTAREA');
    });

    it('should apply Tailwind styling classes by default', () => {
      render(<FormTextarea placeholder="Test textarea" />);

      const textarea = screen.getByPlaceholderText('Test textarea');
      expect(textarea).toHaveClass('w-full', 'bg-background-dark', 'border', 'border-border-dark', 'rounded-2xl');
    });

    it('should apply custom className', () => {
      render(<FormTextarea placeholder="Test textarea" className="custom-textarea" />);

      const textarea = screen.getByPlaceholderText('Test textarea');
      expect(textarea).toHaveClass('custom-textarea');
    });

    it('should pass through textarea attributes', () => {
      render(
        <FormTextarea
          placeholder="Enter description"
          rows={5}
          cols={50}
          required
          id="description-textarea"
        />
      );

      const textarea = screen.getByPlaceholderText('Enter description');
      expect(textarea).toHaveAttribute('rows', '5');
      expect(textarea).toHaveAttribute('cols', '50');
      expect(textarea).toHaveAttribute('required');
      expect(textarea).toHaveAttribute('id', 'description-textarea');
    });
  });

  describe('Error State', () => {
    it('should apply error class when error is true', () => {
      render(<FormTextarea placeholder="Error textarea" error />);

      const textarea = screen.getByPlaceholderText('Error textarea');
      expect(textarea).toHaveClass('border-red-500');
    });

    it('should not apply error class by default', () => {
      render(<FormTextarea placeholder="Normal textarea" />);

      const textarea = screen.getByPlaceholderText('Normal textarea');
      expect(textarea).not.toHaveClass('border-red-500');
    });

    it('should not apply error class when error is false', () => {
      render(<FormTextarea placeholder="Normal textarea" error={false} />);

      const textarea = screen.getByPlaceholderText('Normal textarea');
      expect(textarea).not.toHaveClass('border-red-500');
    });
  });

  describe('Event Handling', () => {
    it('should handle change events', () => {
      const handleChange = vi.fn();
      render(<FormTextarea placeholder="Test textarea" onChange={handleChange} />);

      const textarea = screen.getByPlaceholderText('Test textarea');
      fireEvent.change(textarea, { target: { value: 'test content' } });

      expect(handleChange).toHaveBeenCalledTimes(1);
    });
  });
});

describe('FormSection Component', () => {
  describe('Basic Rendering', () => {
    it('should render section with children', () => {
      render(
        <FormSection>
          <div>Section content</div>
        </FormSection>
      );

      expect(screen.getByText('Section content')).toBeInTheDocument();
    });

    it('should apply form-section class by default', () => {
      render(
        <FormSection>
          <div>Content</div>
        </FormSection>
      );

      const section = document.querySelector('.form-section');
      expect(section).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(
        <FormSection className="custom-section">
          <div>Content</div>
        </FormSection>
      );

      const section = document.querySelector('.form-section');
      expect(section).toHaveClass('form-section', 'custom-section');
    });
  });

  describe('Section Header', () => {
    it('should render title when provided', () => {
      render(
        <FormSection title="Section Title">
          <div>Content</div>
        </FormSection>
      );

      expect(screen.getByText('Section Title')).toBeInTheDocument();

      const title = screen.getByRole('heading', { level: 3 });
      expect(title).toHaveTextContent('Section Title');
      expect(title).toHaveClass('form-section-title');
    });

    it('should render description when provided', () => {
      render(
        <FormSection description="This is a section description">
          <div>Content</div>
        </FormSection>
      );

      const description = screen.getByText('This is a section description');
      expect(description).toBeInTheDocument();
      expect(description.tagName).toBe('P');
      expect(description).toHaveClass('form-section-description');
    });

    it('should render both title and description', () => {
      render(
        <FormSection
          title="Section Title"
          description="Section description"
        >
          <div>Content</div>
        </FormSection>
      );

      expect(screen.getByText('Section Title')).toBeInTheDocument();
      expect(screen.getByText('Section description')).toBeInTheDocument();

      const header = document.querySelector('.form-section-header');
      expect(header).toBeInTheDocument();
    });

    it('should not render header when no title or description', () => {
      render(
        <FormSection>
          <div>Content</div>
        </FormSection>
      );

      expect(document.querySelector('.form-section-header')).not.toBeInTheDocument();
    });
  });

  describe('Section Content', () => {
    it('should render content in form-section-content wrapper', () => {
      render(
        <FormSection>
          <div data-testid="section-content">Content</div>
        </FormSection>
      );

      const content = screen.getByTestId('section-content');
      expect(content.parentElement).toHaveClass('form-section-content');
    });
  });
});

describe('Form Components Integration', () => {
  it('should work together in a complete form', () => {
    const handleSubmit = vi.fn((e) => e.preventDefault());
    const handleInputChange = vi.fn();
    const handleTextareaChange = vi.fn();

    const { container } = render(
      <Form onSubmit={handleSubmit}>
        <FormSection
          title="Personal Information"
          description="Please enter your personal details"
        >
          <FormRow>
            <FormGroup>
              <FormLabel htmlFor="name" required>
                Name
              </FormLabel>
              <FormInput
                id="name"
                type="text"
                placeholder="Enter your name"
                onChange={handleInputChange}
              />
              <FormHelp>Enter your full name as it appears on your ID</FormHelp>
            </FormGroup>

            <FormGroup>
              <FormLabel htmlFor="email" required>
                Email
              </FormLabel>
              <FormInput
                id="email"
                type="email"
                placeholder="Enter your email"
                error
              />
              <FormError>Please enter a valid email address</FormError>
            </FormGroup>
          </FormRow>

          <FormGroup>
            <FormLabel htmlFor="bio">
              Biography
            </FormLabel>
            <FormTextarea
              id="bio"
              placeholder="Tell us about yourself"
              rows={4}
              onChange={handleTextareaChange}
            />
          </FormGroup>
        </FormSection>

        <button type="submit">Submit</button>
      </Form>
    );

    // Verify all elements are rendered
    expect(container.querySelector('form')).toBeInTheDocument();
    expect(screen.getByText('Personal Information')).toBeInTheDocument();
    expect(screen.getByText('Please enter your personal details')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Tell us about yourself')).toBeInTheDocument();
    expect(screen.getByText('Enter your full name as it appears on your ID')).toBeInTheDocument();
    expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument();

    // Test interactions
    const nameInput = screen.getByPlaceholderText('Enter your name');
    fireEvent.change(nameInput, { target: { value: 'John Doe' } });
    expect(handleInputChange).toHaveBeenCalled();

    const bioTextarea = screen.getByPlaceholderText('Tell us about yourself');
    fireEvent.change(bioTextarea, { target: { value: 'Bio content' } });
    expect(handleTextareaChange).toHaveBeenCalled();

    const submitButton = screen.getByText('Submit');
    fireEvent.click(submitButton);
    expect(handleSubmit).toHaveBeenCalled();
  });

  it('should handle form accessibility correctly', () => {
    const { container } = render(
      <Form>
        <FormGroup>
          <FormLabel htmlFor="accessible-input" required>
            Accessible Input
          </FormLabel>
          <FormInput id="accessible-input" aria-describedby="input-help input-error" />
          <FormHelp id="input-help">This input has help text</FormHelp>
          <FormError id="input-error">This input has an error</FormError>
        </FormGroup>
      </Form>
    );

    const input = container.querySelector('#accessible-input');
    expect(input).toHaveAttribute('aria-describedby', 'input-help input-error');

    const label = screen.getByText('Accessible Input');
    expect(label).toHaveAttribute('for', 'accessible-input');
  });
});
