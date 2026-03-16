/**
 * Marketplace Service
 *
 * Handles fetching the marketplace registry from the Crewly webapp API,
 * managing the local installed-items manifest, and enriching items
 * with install status information.
 *
 * @module services/marketplace/marketplace.service
 */

import { homedir } from 'os';
import path from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import {
  MarketplaceRegistry,
  MarketplaceItem,
  MarketplaceItemWithStatus,
  MarketplaceFilter,
  InstalledItemsManifest,
  InstalledItemRecord,
  type MarketplaceItemType,
} from '../../types/marketplace.types.js';
import { MARKETPLACE_CONSTANTS } from '../../constants.js';

const CREWLY_HOME = path.join(homedir(), '.crewly');
const MARKETPLACE_DIR = path.join(CREWLY_HOME, MARKETPLACE_CONSTANTS.DIR_NAME);
const MANIFEST_PATH = path.join(MARKETPLACE_DIR, MARKETPLACE_CONSTANTS.MANIFEST_FILE);
const LOCAL_REGISTRY_PATH = path.join(MARKETPLACE_DIR, MARKETPLACE_CONSTANTS.LOCAL_REGISTRY_FILE);

/** Pattern for valid marketplace item IDs: lowercase alphanumeric with hyphens */
const VALID_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9\-]*$/;

let cachedRegistry: MarketplaceRegistry | null = null;
let cacheTimestamp = 0;
let fetchInFlight: Promise<MarketplaceRegistry> | null = null;

/**
 * Validates that a marketplace item ID is safe (no path traversal).
 *
 * @param id - The item ID to validate
 * @returns True if the ID matches the allowed pattern
 */
function isValidItemId(id: string): boolean {
  return VALID_ITEM_ID_PATTERN.test(id);
}

/**
 * Fetches the marketplace registry from the Crewly webapp API.
 * Uses in-memory caching with a 1-hour TTL. Concurrent callers share
 * the same in-flight request to avoid duplicate network fetches.
 *
 * On network failure, falls back to the previously cached registry
 * if one is available. Throws only when no cached data exists.
 *
 * @param forceRefresh - If true, bypasses the cache and fetches fresh data
 * @returns The marketplace registry containing all available items
 * @throws Error if the fetch fails and no cached registry is available
 */
export async function fetchRegistry(forceRefresh = false): Promise<MarketplaceRegistry> {
  const now = Date.now();
  if (!forceRefresh && cachedRegistry && now - cacheTimestamp < MARKETPLACE_CONSTANTS.CACHE_TTL) {
    return cachedRegistry;
  }

  // When forceRefresh is true, wait for any in-flight request to complete
  // before starting a new fetch to avoid returning stale data
  if (forceRefresh && fetchInFlight) {
    await fetchInFlight.catch(() => {});
    // Fall through to start a new fetch
  }

  // Deduplicate concurrent requests
  if (fetchInFlight) {
    return fetchInFlight;
  }

  fetchInFlight = doFetchRegistry(now).finally(() => {
    fetchInFlight = null;
  });

  return fetchInFlight;
}

/**
 * Internal fetch implementation. Separated to enable in-flight deduplication.
 *
 * Fetches from two sources in parallel:
 * 1. Public registry -- GitHub raw content (config/skills/registry.json in crewly repo)
 * 2. Premium registry -- crewlyai.com/api/registry/skills (private/paid skills)
 *
 * Results are merged with local registry items (locally published skills).
 *
 * When both remote sources fail and no local items exist, the empty registry
 * is returned but NOT cached so the next call will retry immediately.
 */
async function doFetchRegistry(now: number): Promise<MarketplaceRegistry> {
  // Fetch public and premium registries in parallel
  const [publicResult, premiumResult] = await Promise.allSettled([
    fetchPublicRegistry(),
    fetchPremiumRegistry(),
  ]);

  const publicItems = publicResult.status === 'fulfilled' ? publicResult.value : [];
  const premiumItems = premiumResult.status === 'fulfilled' ? premiumResult.value : [];

  // If both failed and we have a cache, return cache
  if (publicItems.length === 0 && premiumItems.length === 0 && cachedRegistry) {
    return cachedRegistry;
  }

  // Merge: public + premium (premium overwrites by ID if conflict)
  const mergedMap = new Map<string, MarketplaceItem>();
  for (const item of publicItems) {
    mergedMap.set(item.id, item);
  }
  for (const item of premiumItems) {
    mergedMap.set(item.id, item);
  }

  // Merge locally published skills
  const localItems = await loadLocalRegistry();
  for (const item of localItems) {
    if (!mergedMap.has(item.id)) {
      mergedMap.set(item.id, item);
    }
  }

  const registry: MarketplaceRegistry = {
    schemaVersion: MARKETPLACE_CONSTANTS.SCHEMA_VERSION,
    lastUpdated: new Date().toISOString(),
    cdnBaseUrl: MARKETPLACE_CONSTANTS.PUBLIC_CDN_BASE,
    items: Array.from(mergedMap.values()),
  };

  // Only cache non-empty registries so that next call retries on total failure
  if (mergedMap.size > 0) {
    cachedRegistry = registry;
    cacheTimestamp = now;
  }

  return registry;
}

/**
 * Fetches items from the public registry (GitHub raw content).
 *
 * @returns Array of public marketplace items, empty on failure
 */
async function fetchPublicRegistry(): Promise<MarketplaceItem[]> {
  try {
    const res = await fetch(MARKETPLACE_CONSTANTS.PUBLIC_REGISTRY_URL, {
      signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.REGISTRY_FETCH_TIMEOUT),
    });
    if (res.ok) {
      const data = (await res.json()) as MarketplaceRegistry;
      return data.items || [];
    }
  } catch {
    // Public registry unavailable -- continue with empty
  }
  return [];
}

/**
 * Fetches items from the premium registry (crewlyai.com).
 *
 * @returns Array of premium marketplace items with premium flag, empty on failure
 */
async function fetchPremiumRegistry(): Promise<MarketplaceItem[]> {
  try {
    const url = `${MARKETPLACE_CONSTANTS.PREMIUM_BASE_URL}${MARKETPLACE_CONSTANTS.PREMIUM_REGISTRY_ENDPOINT}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(MARKETPLACE_CONSTANTS.REGISTRY_FETCH_TIMEOUT),
    });
    if (res.ok) {
      const data = (await res.json()) as MarketplaceRegistry;
      return (data.items || []).map((item) => ({
        ...item,
        metadata: { ...item.metadata, premium: true },
      }));
    }
  } catch {
    // Premium registry unavailable -- continue without premium skills
  }
  return [];
}

/**
 * Loads locally published marketplace items from the local registry file.
 *
 * These are skills that were submitted and approved through the local
 * submission workflow.
 *
 * @returns Array of locally published marketplace items
 */
async function loadLocalRegistry(): Promise<MarketplaceItem[]> {
  try {
    const data = await readFile(LOCAL_REGISTRY_PATH, 'utf-8');
    const registry = JSON.parse(data) as { items?: unknown };
    if (!Array.isArray(registry.items)) {
      return [];
    }
    return registry.items as MarketplaceItem[];
  } catch {
    return [];
  }
}

/**
 * Loads the locally installed items manifest from disk.
 *
 * Returns an empty manifest (schemaVersion 1, no items) if the
 * manifest file does not exist or cannot be parsed.
 *
 * @returns The installed items manifest
 */
export async function loadManifest(): Promise<InstalledItemsManifest> {
  try {
    const data = await readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(data) as InstalledItemsManifest;
  } catch {
    return { schemaVersion: 1, items: [] };
  }
}

/**
 * Saves the installed items manifest to disk.
 *
 * Creates the marketplace directory if it does not exist.
 *
 * @param manifest - The manifest to persist
 */
export async function saveManifest(manifest: InstalledItemsManifest): Promise<void> {
  await mkdir(MARKETPLACE_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Returns a single marketplace item by ID, enriched with install status.
 *
 * @param id - The marketplace item ID to look up
 * @returns The item with install status, or null if not found in the registry
 */
export async function getItem(id: string): Promise<MarketplaceItemWithStatus | null> {
  const registry = await fetchRegistry();
  const item = registry.items.find((i) => i.id === id);
  if (!item) return null;
  const manifest = await loadManifest();
  const installedMap = new Map(manifest.items.map((r) => [r.id, r]));
  return enrichWithStatusFromMap(item, installedMap);
}

/**
 * Lists marketplace items with optional filtering, enriched with install status.
 *
 * Supports filtering by type, category, and free-text search (matches name,
 * description, and tags). Results are sorted by the specified sort option,
 * defaulting to most popular (highest downloads).
 *
 * @param filter - Optional filter and sort criteria
 * @returns Filtered and sorted list of items with install status
 */
export async function listItems(filter?: MarketplaceFilter): Promise<MarketplaceItemWithStatus[]> {
  const registry = await fetchRegistry();
  // Shallow copy to avoid mutating the cached registry's items array via .sort()
  let items = [...registry.items];

  if (filter?.type) {
    items = items.filter((i) => i.type === filter.type);
  }
  if (filter?.category) {
    items = items.filter((i) => i.category === filter.category);
  }
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  switch (filter?.sortBy) {
    case 'popular':
      items.sort((a, b) => b.downloads - a.downloads);
      break;
    case 'rating':
      items.sort((a, b) => b.rating - a.rating);
      break;
    case 'newest':
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      break;
    default:
      items.sort((a, b) => b.downloads - a.downloads);
  }

  const manifest = await loadManifest();
  // Use Map for O(n+m) enrichment instead of O(n*m) linear scan per item
  const installedMap = new Map(manifest.items.map((r) => [r.id, r]));
  return items.map((i) => enrichWithStatusFromMap(i, installedMap));
}

/**
 * Returns marketplace items that have updates available.
 *
 * An item has an update available when the installed version differs
 * from the latest version in the registry.
 *
 * @returns Items with installStatus 'update_available'
 */
export async function getUpdatableItems(): Promise<MarketplaceItemWithStatus[]> {
  const all = await listItems();
  return all.filter((i) => i.installStatus === 'update_available');
}

/**
 * Returns locally installed items from the manifest.
 *
 * @returns Array of installed item records
 */
export async function getInstalledItems(): Promise<InstalledItemRecord[]> {
  const manifest = await loadManifest();
  return manifest.items;
}

/**
 * Searches marketplace items by query string.
 *
 * Convenience wrapper around listItems with a search filter.
 *
 * @param query - Free-text search query
 * @returns Matching items with install status
 */
export async function searchItems(query: string): Promise<MarketplaceItemWithStatus[]> {
  return listItems({ search: query });
}

/**
 * Enriches a marketplace item with its local install status using a pre-built Map.
 *
 * @param item - The marketplace item from the registry
 * @param installedMap - Map of installed item ID to record for O(1) lookup
 * @returns The item enriched with installStatus and optional installedVersion
 */
function enrichWithStatusFromMap(
  item: MarketplaceItem,
  installedMap: Map<string, InstalledItemRecord>
): MarketplaceItemWithStatus {
  const installed = installedMap.get(item.id);
  if (!installed) {
    return { ...item, installStatus: 'not_installed' };
  }
  if (installed.version !== item.version) {
    return { ...item, installStatus: 'update_available', installedVersion: installed.version };
  }
  return { ...item, installStatus: 'installed', installedVersion: installed.version };
}

/**
 * Returns the local install path for a marketplace item.
 *
 * Maps item types to directory names:
 * - 'skill' -> 'skills'
 * - 'model' -> 'models'
 * - 'role'  -> 'roles'
 *
 * @param type - The marketplace item type
 * @param id - The marketplace item ID
 * @returns Absolute path to the item's install directory
 * @throws Error if the id contains path traversal characters
 */
const TYPE_DIR_MAP: Record<MarketplaceItemType, string> = {
  skill: 'skills',
  model: 'models',
  role: 'roles',
  mcp_tool: 'mcp-tools',
};

export function getInstallPath(type: MarketplaceItemType, id: string): string {
  if (!isValidItemId(id)) {
    throw new Error(`Invalid marketplace item ID "${id}": must match ${VALID_ITEM_ID_PATTERN}`);
  }
  const typeDir = TYPE_DIR_MAP[type];
  return path.join(MARKETPLACE_DIR, typeDir, id);
}

/**
 * Resets the in-memory registry cache.
 *
 * Used primarily for testing to ensure a clean state between test runs.
 */
export function resetRegistryCache(): void {
  cachedRegistry = null;
  cacheTimestamp = 0;
  fetchInFlight = null;
}
