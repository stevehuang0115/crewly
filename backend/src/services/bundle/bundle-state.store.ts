/**
 * Bundle deployment store — `<crewlyHome>/bundles/<templateId>.json`.
 *
 * One file per deployed template. The apply engine writes it after every
 * step, so a crash or a failed step leaves an accurate record and a re-run
 * resumes from it. Writes are atomic (temp file + rename).
 *
 * @module services/bundle/bundle-state.store
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { BUNDLE_CONSTANTS } from '../../constants.js';
import type { BundleDeployment } from '../../types/solution-bundle.types.js';
import { atomicWriteFile } from '../../utils/file-io.utils.js';

/** Template ids become file names; keep them to safe characters. */
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Persists bundle deployments.
 */
export class BundleDeploymentStore {
  private readonly dir: string;

  /**
   * @param crewlyHome - Crewly home directory
   */
  constructor(crewlyHome: string) {
    this.dir = path.join(crewlyHome, BUNDLE_CONSTANTS.STATE_DIR);
  }

  /**
   * File of a template's deployment.
   *
   * @param templateId - Template id (kebab case)
   * @returns Absolute path
   * @throws Error for an id that is not a safe file name
   */
  fileFor(templateId: string): string {
    if (!SAFE_ID_PATTERN.test(templateId)) throw new Error(`Invalid template id: ${templateId}`);
    return path.join(this.dir, `${templateId}.json`);
  }

  /**
   * Read a deployment.
   *
   * @param templateId - Template id
   * @returns The deployment, or null when the template was never deployed (or the file is unreadable)
   */
  async read(templateId: string): Promise<BundleDeployment | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(templateId), 'utf-8')) as BundleDeployment;
      return parsed && parsed.templateId === templateId && Array.isArray(parsed.steps) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Write a deployment atomically.
   *
   * @param deployment - Deployment
   */
  async write(deployment: BundleDeployment): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWriteFile(this.fileFor(deployment.templateId), JSON.stringify(deployment, null, 2));
  }

  /**
   * Every stored deployment.
   *
   * @returns Deployments (unreadable files are skipped)
   */
  async list(): Promise<BundleDeployment[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: BundleDeployment[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!SAFE_ID_PATTERN.test(id)) continue;
      const deployment = await this.read(id);
      if (deployment) out.push(deployment);
    }
    return out;
  }
}
