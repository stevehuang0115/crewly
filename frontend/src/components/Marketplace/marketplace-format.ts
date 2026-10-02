/**
 * Display helpers shared by the Marketplace list and item detail page.
 *
 * @module components/Marketplace/marketplace-format
 */

import type { MarketplaceItemType } from '../../types/marketplace.types';

/** Human label per item type. */
export const ITEM_TYPE_LABEL: Record<MarketplaceItemType, string> = {
  skill: 'Skill',
  model: '3D Model',
  role: 'Role',
  mcp_tool: 'MCP Tool',
};

/**
 * Format a download count for compact display ("1.5k").
 *
 * @param n - Download count
 * @returns Formatted string
 */
export function formatDownloads(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
