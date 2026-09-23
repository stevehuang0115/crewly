/**
 * Avatar Component - Displays user/entity avatars with fallback support.
 *
 * Handles multiple avatar source types:
 * - Image URLs (http://, https://, data:)
 * - Emoji or single character
 * - Fallback to initials from name
 */

import React from 'react';

/**
 * Size configuration for avatar variants
 */
const AVATAR_SIZES = {
  xs: 'w-4 h-4 text-xs',
  sm: 'w-6 h-6 text-xs',
  md: 'w-8 h-8 text-sm',
  lg: 'w-10 h-10 text-base',
  xl: 'w-12 h-12 text-lg',
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZES;

/**
 * Props for the Avatar component
 */
export interface AvatarProps {
  /** Avatar image URL, emoji, or single character */
  src?: string;
  /** Name to extract initials from (fallback) */
  name?: string;
  /** Secondary name/identifier for fallback */
  fallbackName?: string;
  /** Size variant */
  size?: AvatarSize;
  /** Additional CSS classes */
  className?: string;
  /** Alt text for image avatars */
  alt?: string;
  /** Title attribute for hover tooltip */
  title?: string;
  /** Show ring/border around avatar */
  showRing?: boolean;
}

/**
 * Determines if a string is an image URL
 *
 * @param value - String to check
 * @returns true if value is an http/https/data URL
 */
function isImageUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('data:')
  );
}

/**
 * Extracts initials from a name
 *
 * @param name - Full name or identifier
 * @returns First character uppercased, or '?' as default
 */
function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

/**
 * Avatar component with intelligent fallback handling.
 *
 * Rendering priority:
 * 1. If src is an image URL -> renders <img>
 * 2. If src is a single character/emoji -> renders in container
 * 3. Falls back to initials from name -> fallbackName -> '?'
 *
 * @example
 * ```tsx
 * // Image avatar
 * <Avatar src="https://example.com/avatar.jpg" name="John Doe" />
 *
 * // Emoji avatar
 * <Avatar src="🎉" name="Party Bot" />
 *
 * // Initials fallback
 * <Avatar name="Jane Smith" />
 * ```
 */
export const Avatar: React.FC<AvatarProps> = ({
  src,
  name = '',
  fallbackName = '',
  size = 'sm',
  className = '',
  alt,
  title,
  showRing = true,
}) => {
  const sizeClasses = AVATAR_SIZES[size];
  const ringClasses = showRing ? 'ring-2 ring-surface-dark' : '';
  const displayName = name || fallbackName || '';
  const effectiveTitle = title || displayName;
  const effectiveAlt = alt || displayName || 'Avatar';

  // Base container classes
  const baseClasses = `rounded-full ${sizeClasses} ${ringClasses} ${className}`.trim();

  // Image URL avatar
  if (src && isImageUrl(src)) {
    return (
      <img
        className={`${baseClasses} bg-cover bg-center object-cover`}
        src={src}
        alt={effectiveAlt}
        title={effectiveTitle}
      />
    );
  }

  // Character/emoji avatar
  if (src && src.length > 0) {
    return (
      <div
        className={`${baseClasses} bg-surface-dark border border-border-dark flex items-center justify-center text-text-secondary-dark`}
        title={effectiveTitle}
      >
        {src}
      </div>
    );
  }

  // Initials fallback
  const initials = getInitials(displayName);
  return (
    <div
      className={`${baseClasses} bg-surface-dark border border-border-dark flex items-center justify-center text-text-secondary-dark`}
      title={effectiveTitle}
    >
      {initials}
    </div>
  );
};

/**
 * Avatar Group component for displaying multiple avatars stacked.
 */
export interface AvatarGroupProps {
  /** Array of avatar props */
  avatars: AvatarProps[];
  /** Maximum avatars to show before +N indicator */
  max?: number;
  /** Size variant for all avatars */
  size?: AvatarSize;
  /** Additional CSS classes for container */
  className?: string;
}

/**
 * Displays a group of avatars with overlap and overflow indicator.
 *
 * @example
 * ```tsx
 * <AvatarGroup
 *   avatars={[
 *     { src: 'url1', name: 'John' },
 *     { src: 'url2', name: 'Jane' },
 *     { name: 'Bob' },
 *   ]}
 *   max={3}
 * />
 * ```
 */
export const AvatarGroup: React.FC<AvatarGroupProps> = ({
  avatars,
  max = 4,
  size = 'sm',
  className = '',
}) => {
  const visibleAvatars = avatars.slice(0, max);
  const overflowCount = avatars.length - max;

  return (
    <div className={`flex -space-x-2 ${className}`}>
      {visibleAvatars.map((avatar, index) => (
        <Avatar key={index} {...avatar} size={size} showRing />
      ))}
      {overflowCount > 0 && (
        <div
          className={`${AVATAR_SIZES[size]} rounded-full bg-primary/20 text-primary border border-primary/30 flex items-center justify-center ring-2 ring-surface-dark`}
          title={`+${overflowCount} more`}
        >
          +{overflowCount}
        </div>
      )}
    </div>
  );
};

export default Avatar;
