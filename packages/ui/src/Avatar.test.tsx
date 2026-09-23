/**
 * Tests for Avatar Component.
 *
 * Covers Avatar and AvatarGroup rendering with various props including
 * image URLs, emoji, initials fallback, and size variants.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Avatar, AvatarGroup, AvatarProps } from './Avatar';

describe('Avatar', () => {
  describe('rendering', () => {
    it('should render an img element for http URL', () => {
      render(<Avatar src="https://example.com/avatar.jpg" name="John" />);

      const img = screen.getByRole('img');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
    });

    it('should render an img element for https URL', () => {
      render(<Avatar src="https://secure.example.com/avatar.png" name="Jane" />);

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'https://secure.example.com/avatar.png');
    });

    it('should render an img element for data URL', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
      render(<Avatar src={dataUrl} name="Bob" />);

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', dataUrl);
    });

    it('should render character/emoji in a div', () => {
      render(<Avatar src="J" name="John" />);

      expect(screen.getByText('J')).toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('should render emoji directly', () => {
      render(<Avatar src="🎉" name="Party" />);

      expect(screen.getByText('🎉')).toBeInTheDocument();
    });

    it('should render initials when no src is provided', () => {
      render(<Avatar name="John Doe" />);

      expect(screen.getByText('J')).toBeInTheDocument();
    });

    it('should use fallbackName when name is empty', () => {
      render(<Avatar name="" fallbackName="session-123" />);

      expect(screen.getByText('S')).toBeInTheDocument();
    });

    it('should render ? when no name or fallbackName', () => {
      render(<Avatar />);

      expect(screen.getByText('?')).toBeInTheDocument();
    });

    it('should handle empty string src as initials fallback', () => {
      render(<Avatar src="" name="Alice" />);

      expect(screen.getByText('A')).toBeInTheDocument();
    });
  });

  describe('sizes', () => {
    it('should apply xs size classes', () => {
      render(<Avatar name="A" size="xs" />);

      const avatar = screen.getByText('A');
      expect(avatar).toHaveClass('w-4', 'h-4');
    });

    it('should apply sm size classes (default)', () => {
      render(<Avatar name="B" />);

      const avatar = screen.getByText('B');
      expect(avatar).toHaveClass('w-6', 'h-6');
    });

    it('should apply md size classes', () => {
      render(<Avatar name="C" size="md" />);

      const avatar = screen.getByText('C');
      expect(avatar).toHaveClass('w-8', 'h-8');
    });

    it('should apply lg size classes', () => {
      render(<Avatar name="D" size="lg" />);

      const avatar = screen.getByText('D');
      expect(avatar).toHaveClass('w-10', 'h-10');
    });

    it('should apply xl size classes', () => {
      render(<Avatar name="E" size="xl" />);

      const avatar = screen.getByText('E');
      expect(avatar).toHaveClass('w-12', 'h-12');
    });
  });

  describe('ring/border', () => {
    it('should show ring by default', () => {
      render(<Avatar name="F" />);

      const avatar = screen.getByText('F');
      expect(avatar).toHaveClass('ring-2');
    });

    it('should hide ring when showRing is false', () => {
      render(<Avatar name="G" showRing={false} />);

      const avatar = screen.getByText('G');
      expect(avatar).not.toHaveClass('ring-2');
    });
  });

  describe('accessibility', () => {
    it('should use name for alt text on image', () => {
      render(<Avatar src="https://example.com/a.jpg" name="John Doe" />);

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('alt', 'John Doe');
    });

    it('should use custom alt text when provided', () => {
      render(<Avatar src="https://example.com/a.jpg" name="John" alt="Custom alt" />);

      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('alt', 'Custom alt');
    });

    it('should use title attribute for tooltip', () => {
      render(<Avatar name="John Doe" title="John's Avatar" />);

      const avatar = screen.getByText('J');
      expect(avatar).toHaveAttribute('title', "John's Avatar");
    });

    it('should default title to name', () => {
      render(<Avatar name="Jane Smith" />);

      const avatar = screen.getByText('J');
      expect(avatar).toHaveAttribute('title', 'Jane Smith');
    });
  });

  describe('custom className', () => {
    it('should apply custom className', () => {
      render(<Avatar name="H" className="custom-class" />);

      const avatar = screen.getByText('H');
      expect(avatar).toHaveClass('custom-class');
    });
  });
});

describe('AvatarGroup', () => {
  const mockAvatars: AvatarProps[] = [
    { src: 'https://example.com/1.jpg', name: 'User 1' },
    { name: 'User 2' },
    { src: '🎉', name: 'User 3' },
    { src: 'https://example.com/4.jpg', name: 'User 4' },
  ];

  describe('rendering', () => {
    it('should render all avatars when count is at or below max', () => {
      render(<AvatarGroup avatars={mockAvatars.slice(0, 3)} max={4} />);

      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(screen.getByText('U')).toBeInTheDocument(); // User 2 initials
      expect(screen.getByText('🎉')).toBeInTheDocument();
    });

    it('should show overflow indicator when exceeding max', () => {
      render(<AvatarGroup avatars={mockAvatars} max={2} />);

      expect(screen.getByText('+2')).toBeInTheDocument();
    });

    it('should not show overflow indicator when at exactly max', () => {
      render(<AvatarGroup avatars={mockAvatars.slice(0, 4)} max={4} />);

      expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    });

    it('should respect custom max value', () => {
      render(<AvatarGroup avatars={mockAvatars} max={1} />);

      expect(screen.getByText('+3')).toBeInTheDocument();
    });

    it('should apply consistent size to all avatars', () => {
      render(<AvatarGroup avatars={[{ name: 'A' }, { name: 'B' }]} size="lg" />);

      const avatars = screen.getAllByText(/[AB]/);
      avatars.forEach(avatar => {
        expect(avatar).toHaveClass('w-10', 'h-10');
      });
    });
  });

  describe('custom className', () => {
    it('should apply custom className to container', () => {
      const { container } = render(
        <AvatarGroup avatars={[{ name: 'A' }]} className="my-custom-class" />
      );

      const group = container.firstChild;
      expect(group).toHaveClass('my-custom-class');
    });
  });

  describe('edge cases', () => {
    it('should handle empty avatars array', () => {
      const { container } = render(<AvatarGroup avatars={[]} />);

      expect(container.firstChild).toBeEmptyDOMElement();
    });

    it('should handle single avatar', () => {
      render(<AvatarGroup avatars={[{ name: 'Single' }]} />);

      expect(screen.getByText('S')).toBeInTheDocument();
      expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    });
  });
});
