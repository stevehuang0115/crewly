/**
 * Shared User Profile Service
 *
 * Manages a single user profile stored at ~/.crewly/user-profile.json that
 * ALL agents can read. The orchestrator is the primary writer, but any agent
 * may update it. This eliminates per-agent preference fragmentation by
 * providing a single source of truth for user preferences.
 *
 * Features:
 * - Read-through cache with configurable TTL (30s default)
 * - Deep merge for preferences, append-only for notes and prohibitions
 * - Prompt-injectable context generation for agent system prompts
 *
 * @module services/memory/user-profile.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { SharedUserProfile } from '../../types/memory.types.js';

/**
 * Service for managing the shared user profile.
 * All agents read from this; orchestrator is the primary writer.
 * Stored at ~/.crewly/user-profile.json
 */
export class UserProfileService {
  private static instance: UserProfileService | null = null;
  private logger: ComponentLogger;
  private profilePath: string;
  private cache: SharedUserProfile | null = null;
  private cacheTime = 0;

  /** Cache time-to-live in milliseconds */
  static CACHE_TTL_MS = 30000;

  /**
   * Create a new UserProfileService instance.
   *
   * @param crewlyHome - Override for the user home directory (defaults to $HOME)
   */
  constructor(crewlyHome?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('UserProfileService');
    const home = crewlyHome || process.env.HOME || process.env.USERPROFILE || '/tmp';
    this.profilePath = path.join(home, '.crewly', 'user-profile.json');
  }

  /**
   * Get or create the singleton instance.
   *
   * @param crewlyHome - Override for the user home directory
   * @returns The singleton UserProfileService instance
   */
  static getInstance(crewlyHome?: string): UserProfileService {
    if (!UserProfileService.instance) {
      UserProfileService.instance = new UserProfileService(crewlyHome);
    }
    return UserProfileService.instance;
  }

  /**
   * Clear the singleton instance. Used for testing.
   */
  static clearInstance(): void {
    UserProfileService.instance = null;
  }

  /**
   * Get the current user profile. Returns empty profile if none exists.
   * Results are cached for CACHE_TTL_MS milliseconds.
   *
   * @returns The current shared user profile, or an empty object if not yet created
   */
  async getProfile(): Promise<SharedUserProfile> {
    if (this.cache && Date.now() - this.cacheTime < UserProfileService.CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      if (fs.existsSync(this.profilePath)) {
        const raw = fs.readFileSync(this.profilePath, 'utf-8');
        this.cache = JSON.parse(raw);
        this.cacheTime = Date.now();
        return this.cache!;
      }
    } catch (err) {
      this.logger.warn('Failed to read user profile', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {};
  }

  /**
   * Update the user profile with partial updates (deep merge).
   *
   * Merge strategy:
   * - Top-level scalar fields are overwritten
   * - `preferences` object is shallow-merged (existing keys preserved, new keys added)
   * - `notes` array is appended (duplicates filtered)
   * - `prohibitions` array is appended (deduplicated via Set)
   * - `updatedAt` and `updatedBy` are always set
   *
   * @param updates - Partial profile fields to merge
   * @param updatedBy - Identifier of who is updating (agentId or 'user')
   * @returns The merged profile after saving
   */
  async updateProfile(updates: Partial<SharedUserProfile>, updatedBy: string): Promise<SharedUserProfile> {
    const current = await this.getProfile();
    const merged: SharedUserProfile = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };

    // Deep merge preferences
    if (updates.preferences && current.preferences) {
      merged.preferences = { ...current.preferences, ...updates.preferences };
    }

    // Append notes rather than replace
    if (updates.notes && current.notes) {
      merged.notes = [...current.notes, ...updates.notes.filter(n => !current.notes!.includes(n))];
    }

    // Append prohibitions rather than replace
    if (updates.prohibitions && current.prohibitions) {
      merged.prohibitions = [...new Set([...current.prohibitions, ...updates.prohibitions])];
    }

    // Ensure directory exists
    const dir = path.dirname(this.profilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.profilePath, JSON.stringify(merged, null, 2), 'utf-8');
    this.cache = merged;
    this.cacheTime = Date.now();

    this.logger.info('User profile updated', { updatedBy, fields: Object.keys(updates) });
    return merged;
  }

  /**
   * Generate a formatted markdown string for prompt injection.
   * Returns null if the profile is empty or contains only metadata fields.
   *
   * @returns Formatted markdown string with user profile context, or null if empty
   */
  async generateProfileContext(): Promise<string | null> {
    const profile = await this.getProfile();
    if (!profile || Object.keys(profile).filter(k => k !== 'updatedAt' && k !== 'updatedBy').length === 0) {
      return null;
    }

    const lines: string[] = ['## Shared User Profile'];
    if (profile.language) lines.push(`- **Language:** ${profile.language}`);
    if (profile.reportingStyle) lines.push(`- **Reporting Style:** ${profile.reportingStyle}`);
    if (profile.riskTolerance) lines.push(`- **Risk Tolerance:** ${profile.riskTolerance}`);
    if (profile.timezone) lines.push(`- **Timezone:** ${profile.timezone}`);
    if (profile.domainContext) lines.push(`- **Domain:** ${profile.domainContext}`);
    if (profile.prohibitions?.length) {
      lines.push('- **Do NOT:**');
      for (const p of profile.prohibitions) lines.push(`  - ${p}`);
    }
    if (profile.preferences && Object.keys(profile.preferences).length > 0) {
      lines.push('- **Preferences:**');
      for (const [k, v] of Object.entries(profile.preferences)) {
        lines.push(`  - ${k}: ${v}`);
      }
    }
    if (profile.notes?.length) {
      lines.push('- **Notes:**');
      for (const n of profile.notes) lines.push(`  - ${n}`);
    }

    return lines.join('\n');
  }
}
