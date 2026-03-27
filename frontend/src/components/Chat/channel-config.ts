/**
 * Shared Channel Configuration
 *
 * Centralized icon, label, and CSS class mapping for chat channel types.
 * Used by ChannelBadge and ChannelFilterBar to avoid duplicated definitions.
 *
 * @module components/Chat/channel-config
 */

import type { ChatChannelType } from '../../types/chat.types';

/**
 * Display configuration for a chat channel type
 */
export interface ChannelDisplayConfig {
  /** Text-based icon label for the channel (no emoji) */
  icon: string;
  /** Human-readable label */
  label: string;
  /** CSS class name for styling */
  className: string;
}

/**
 * Channel display configuration map.
 * Uses single-letter text icons instead of emoji for consistency.
 */
export const CHANNEL_CONFIG: Record<ChatChannelType, ChannelDisplayConfig> = {
  slack: { icon: 'S', label: 'Slack', className: 'channel-slack' },
  crewly_chat: { icon: 'C', label: 'Crewly', className: 'channel-crewly' },
  telegram: { icon: 'T', label: 'Telegram', className: 'channel-telegram' },
  api: { icon: 'A', label: 'API', className: 'channel-api' },
};
