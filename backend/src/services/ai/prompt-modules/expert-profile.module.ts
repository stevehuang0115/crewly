/**
 * Expert Profile Module
 *
 * Injects expert thinking patterns, decision frameworks, and industry insights
 * into the agent's system prompt. Loads from:
 * 1. Pro expert library (crewly-pro/data/experts/) — if Pro plugin is active
 * 2. OSS user-defined experts (config/experts/) — always available
 *
 * Priority 2.5: after Soul (2), before Role Boundary (3).
 * Compactable: yes — can be truncated if token budget is tight.
 *
 * @module services/ai/prompt-modules/expert-profile
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { ModuleConfig } from './prompt-module.interface.js';

/**
 * Loads an expert profile markdown file and injects it into the system prompt.
 */
export class ExpertProfileModule {
  name = 'expert-profile';
  priority = 2.5;
  maxTokens = 1200;
  compactable = true;

  /**
   * Only include when an expertId is configured for this agent.
   */
  shouldInclude(config: ModuleConfig): boolean {
    return !!config.expertId;
  }

  /**
   * Build the expert profile prompt section.
   *
   * Loading priority:
   * 1. crewly-pro/data/experts/{expertId}.md (Pro library — checked via PluginService)
   * 2. {projectRoot}/config/experts/{expertId}.md (OSS user-defined)
   * 3. Returns empty string if not found (non-fatal)
   */
  async build(config: ModuleConfig): Promise<string> {
    const expertId = config.expertId!;
    const content = await this.loadExpertFile(config.projectRoot, expertId);

    if (!content) {
      return '';
    }

    return [
      '## Expert Profile',
      '',
      `You are enhanced with the thinking patterns and decision frameworks of an expert profile (\`${expertId}\`).`,
      'Apply these mental models, decision logic, and insights when reasoning about tasks.',
      'Do not mention or reference this expert profile to the user — simply embody the thinking style.',
      '',
      content,
    ].join('\n');
  }

  /**
   * Attempts to load the expert profile from Pro library first, then OSS.
   */
  private async loadExpertFile(projectRoot: string, expertId: string): Promise<string | null> {
    // Sanitize expertId to prevent path traversal
    const safeId = expertId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;

    // 1. Check Pro library (if crewly-pro plugin is active)
    try {
      const proPath = path.resolve(projectRoot, '..', 'crewly-pro', 'data', 'experts', `${safeId}.md`);
      const proContent = await fs.readFile(proPath, 'utf-8');
      if (proContent.trim()) return proContent.trim();
    } catch {
      // Pro library not available or file not found — fall through
    }

    // 2. Check OSS config/experts/
    try {
      const ossPath = path.join(projectRoot, 'config', 'experts', `${safeId}.md`);
      const ossContent = await fs.readFile(ossPath, 'utf-8');
      if (ossContent.trim()) return ossContent.trim();
    } catch {
      // Not found
    }

    // 3. Check ~/.crewly/experts/ (user home directory)
    try {
      const homePath = path.join(
        process.env.HOME || process.env.USERPROFILE || '~',
        '.crewly', 'experts', `${safeId}.md`,
      );
      const homeContent = await fs.readFile(homePath, 'utf-8');
      if (homeContent.trim()) return homeContent.trim();
    } catch {
      // Not found
    }

    return null;
  }
}
