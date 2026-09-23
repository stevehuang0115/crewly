import React from 'react';

/**
 * Props for the MemberAvatar component
 */
export interface MemberAvatarProps {
  /** The member's name (used for fallback initial and alt text) */
  name: string;
  /** Avatar URL, data URI, or emoji/character */
  avatar?: string;
  /** Size variant */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Additional CSS classes */
  className?: string;
  /** Show online/offline indicator */
  showStatus?: boolean;
  /** Status: active, inactive, activating */
  status?: 'active' | 'inactive' | 'activating';
  /** Custom ring color class (e.g., 'ring-surface-dark') */
  ringClass?: string;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
  xl: 'w-16 h-16 text-xl',
};

const statusColors = {
  active: 'bg-green-500',
  inactive: 'bg-text-secondary-dark',
  activating: 'bg-yellow-500',
};

/**
 * Renders a member avatar with support for images, data URIs, emojis, or initials fallback.
 *
 * Handles three types of avatars:
 * 1. URL/data URI - Renders as an img element
 * 2. Emoji/character - Renders in a styled div
 * 3. No avatar - Shows first letter of name as initial
 *
 * @param props - MemberAvatarProps
 * @returns Avatar element
 *
 * @example
 * ```tsx
 * <MemberAvatar name="John Doe" avatar="https://example.com/avatar.jpg" size="md" />
 * <MemberAvatar name="Jane" avatar="🤖" size="sm" />
 * <MemberAvatar name="Bob" size="lg" /> // Shows "B" initial
 * ```
 */
export const MemberAvatar: React.FC<MemberAvatarProps> = ({
  name,
  avatar,
  size = 'md',
  className = '',
  showStatus = false,
  status,
  ringClass = '',
}) => {
  const sizeClass = sizeClasses[size];

  const renderAvatar = () => {
    // Case 1: Avatar is a URL (http/https) or data URI
    if (avatar && (avatar.startsWith('http') || avatar.startsWith('data:'))) {
      return (
        <img
          src={avatar}
          alt={`${name}'s avatar`}
          title={name}
          className={`${sizeClass} rounded-full object-cover ${ringClass} ${className}`}
        />
      );
    }

    // Case 2: Avatar is an emoji or character
    if (avatar) {
      return (
        <div
          className={`${sizeClass} rounded-full bg-background-dark border border-border-dark flex items-center justify-center ${ringClass} ${className}`}
          title={name}
        >
          <span>{avatar}</span>
        </div>
      );
    }

    // Case 3: No avatar - show initial
    const initial = name ? name.charAt(0).toUpperCase() : '';
    return (
      <div
        className={`${sizeClass} rounded-full bg-background-dark border border-border-dark flex items-center justify-center ${ringClass} ${className}`}
        title={name}
      >
        {initial}
      </div>
    );
  };

  return (
    <div className="relative inline-block">
      {renderAvatar()}
      {showStatus && status && (
        <span
          className={`absolute bottom-0 right-0 w-3 h-3 ${statusColors[status]} rounded-full border-2 border-surface-dark`}
          title={status}
        />
      )}
    </div>
  );
};

export default MemberAvatar;
