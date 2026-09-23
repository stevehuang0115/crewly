import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemberAvatar } from './MemberAvatar';

describe('MemberAvatar', () => {
  describe('rendering modes', () => {
    it('should render image when avatar is a URL', () => {
      render(
        <MemberAvatar
          name="John Doe"
          avatar="https://example.com/avatar.jpg"
        />
      );

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
      expect(img).toHaveAttribute('alt', "John Doe's avatar");
    });

    it('should render image when avatar is a data URI', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
      render(<MemberAvatar name="Jane" avatar={dataUri} />);

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', dataUri);
    });

    it('should render emoji/character when avatar is not a URL', () => {
      render(<MemberAvatar name="Bot" avatar="🤖" />);

      expect(screen.getByText('🤖')).toBeInTheDocument();
    });

    it('should render initial when no avatar is provided', () => {
      render(<MemberAvatar name="Alice" />);

      expect(screen.getByText('A')).toBeInTheDocument();
    });

    it('should handle empty name gracefully', () => {
      render(<MemberAvatar name="" />);

      // Should not crash, might show empty or nothing
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
  });

  describe('sizes', () => {
    it('should apply xs size classes', () => {
      const { container } = render(
        <MemberAvatar name="Test" size="xs" />
      );

      expect(container.firstChild?.firstChild).toHaveClass('w-6', 'h-6');
    });

    it('should apply md size classes by default', () => {
      const { container } = render(<MemberAvatar name="Test" />);

      expect(container.firstChild?.firstChild).toHaveClass('w-10', 'h-10');
    });

    it('should apply xl size classes', () => {
      const { container } = render(
        <MemberAvatar name="Test" size="xl" />
      );

      expect(container.firstChild?.firstChild).toHaveClass('w-16', 'h-16');
    });

    it('should apply sm size classes', () => {
      const { container } = render(
        <MemberAvatar name="Test" size="sm" />
      );

      expect(container.firstChild?.firstChild).toHaveClass('w-8', 'h-8');
    });

    it('should apply lg size classes', () => {
      const { container } = render(
        <MemberAvatar name="Test" size="lg" />
      );

      expect(container.firstChild?.firstChild).toHaveClass('w-12', 'h-12');
    });
  });

  describe('status indicator', () => {
    it('should show status indicator when showStatus is true', () => {
      const { container } = render(
        <MemberAvatar name="Test" showStatus status="active" />
      );

      const statusIndicator = container.querySelector('.bg-green-500');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('should not show status indicator by default', () => {
      const { container } = render(
        <MemberAvatar name="Test" status="active" />
      );

      const statusIndicator = container.querySelector('.bg-green-500');
      expect(statusIndicator).not.toBeInTheDocument();
    });

    it('should show yellow for activating status', () => {
      const { container } = render(
        <MemberAvatar name="Test" showStatus status="activating" />
      );

      const statusIndicator = container.querySelector('.bg-yellow-500');
      expect(statusIndicator).toBeInTheDocument();
    });

    it('should show the neutral (secondary-text token) dot for inactive status', () => {
      const { container } = render(
        <MemberAvatar name="Test" showStatus status="inactive" />
      );

      const statusIndicator = container.querySelector('.bg-text-secondary-dark');
      expect(statusIndicator).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should have alt text for images', () => {
      render(
        <MemberAvatar
          name="John"
          avatar="https://example.com/avatar.jpg"
        />
      );

      expect(screen.getByRole('img')).toHaveAttribute('alt', "John's avatar");
    });

    it('should have title attribute for non-image avatars', () => {
      const { container } = render(<MemberAvatar name="Jane" avatar="🤖" />);

      expect(container.querySelector('[title="Jane"]')).toBeInTheDocument();
    });

    it('should have title attribute for initial avatars', () => {
      const { container } = render(<MemberAvatar name="Bob" />);

      expect(container.querySelector('[title="Bob"]')).toBeInTheDocument();
    });
  });

  describe('custom className', () => {
    it('should apply custom className', () => {
      const { container } = render(
        <MemberAvatar name="Test" className="custom-class" />
      );

      expect(container.querySelector('.custom-class')).toBeInTheDocument();
    });
  });

  describe('ringClass', () => {
    it('should apply ring class when provided', () => {
      const { container } = render(
        <MemberAvatar name="Test" ringClass="ring-2 ring-surface-dark" />
      );

      expect(container.querySelector('.ring-2')).toBeInTheDocument();
      expect(container.querySelector('.ring-surface-dark')).toBeInTheDocument();
    });
  });
});
