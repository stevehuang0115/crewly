/**
 * KR Skill Measurer — fills `measurementSource: 'skill_output'` Key Results
 * from a skill's JSON output.
 *
 * Until 2026-09-18 a KR's value had exactly three ways to change and all of
 * them were a hand-made API call, so "tickets waiting for acceptance" or
 * "build pass rate" could only be tracked by someone remembering to type the
 * number in. A KR configured as
 *
 * ```json
 * { "measurementSource": "skill_output",
 *   "measurementConfig": { "skill": "steamfun-ticket-count",
 *                          "args": { "status": "review" },
 *                          "jsonPath": ".count" } }
 * ```
 *
 * is now measured on every mission sweep: the named skill's `execute.sh` is
 * run with the JSON args, the number at `jsonPath` is read from its stdout
 * and recorded as a measurement (deduped when unchanged since the last one).
 *
 * Safety: `skill` is a bare name (`[a-z0-9-]`) resolved against the known
 * skill roots only — never a path — and runs with a hard timeout and a
 * bounded output size. This is the same trust boundary as an agent running
 * the skill itself, not a new one.
 *
 * @module services/v3/kr-skill-measurer.service
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import type { KeyResult } from '../../types/v2/key-result.types.js';
import { KR_SKILL_MEASURER_CONSTANTS } from '../../constants.js';

/** Shape of `measurementConfig` for a `skill_output` KR. */
export interface SkillOutputMeasurementConfig {
  /** Bare skill directory name, e.g. `steamfun-ticket-count`. */
  skill: string;
  /** JSON object passed to the skill as its single argument. */
  args?: Record<string, unknown>;
  /** Dot path into the skill's JSON stdout, e.g. `.count` or `.data.total`. Default `.value`. */
  jsonPath?: string;
}

/** What one measurement attempt produced. */
export interface SkillMeasurementOutcome {
  krId: string;
  status: 'recorded' | 'unchanged' | 'skipped' | 'failed';
  value?: number;
  reason?: string;
}

/** Runs a resolved skill and returns its stdout. Injectable for tests. */
export type SkillRunner = (executePath: string, argsJson: string, timeoutMs: number) => Promise<string>;

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Default runner: `bash <execute.sh> '<json>'` with a timeout and output cap.
 *
 * @param executePath - Absolute path of the skill's execute.sh
 * @param argsJson - JSON argument string
 * @param timeoutMs - Kill the skill after this long
 * @returns stdout
 */
export const defaultSkillRunner: SkillRunner = (executePath, argsJson, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      'bash',
      [executePath, argsJson],
      {
        timeout: timeoutMs,
        maxBuffer: KR_SKILL_MEASURER_CONSTANTS.MAX_OUTPUT_BYTES,
        cwd: path.dirname(executePath),
        env: { ...process.env, CREWLY_SKILL_FULL_OUTPUT: '1' },
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });

/**
 * Read a dot path (`.a.b.c`, leading dot optional) out of parsed JSON.
 *
 * @param value - Parsed JSON
 * @param jsonPath - Dot path
 * @returns The value at the path, or undefined
 */
export function readJsonPath(value: unknown, jsonPath: string): unknown {
  const parts = jsonPath.replace(/^\./, '').split('.').filter(Boolean);
  let cur: unknown = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Coerce a skill output value to a number: numbers as is, booleans to 1/0,
 * numeric strings parsed. Anything else is undefined.
 *
 * @param raw - Value read from the skill output
 * @returns A finite number or undefined
 */
export function coerceMeasurement(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Measures `skill_output` Key Results by running their skill.
 */
export class KRSkillMeasurerService {
  private static instance: KRSkillMeasurerService | null = null;
  private readonly logger: ComponentLogger;
  private readonly runner: SkillRunner;
  private readonly skillRoots: string[];
  private readonly krTracking: KRTrackingService;

  /**
   * @param opts - Test seams: skill roots to search, a runner, a KR service
   */
  constructor(opts: { skillRoots?: string[]; runner?: SkillRunner; krTracking?: KRTrackingService; projectRoot?: string } = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('KRSkillMeasurer');
    this.runner = opts.runner ?? defaultSkillRunner;
    this.krTracking = opts.krTracking ?? KRTrackingService.getInstance();
    const projectRoot = opts.projectRoot ?? process.cwd();
    this.skillRoots = opts.skillRoots ?? [
      path.join(os.homedir(), '.crewly', 'skills', 'agent'),
      path.join(os.homedir(), '.crewly', 'marketplace', 'skills'),
      path.join(projectRoot, 'config', 'skills', 'agent'),
      path.join(projectRoot, 'config', 'skills', 'agent', 'core'),
      path.join(projectRoot, 'config', 'skills', 'orchestrator'),
      path.join(projectRoot, 'config', 'skills', 'team-leader'),
    ];
  }

  static getInstance(): KRSkillMeasurerService {
    if (!this.instance) this.instance = new KRSkillMeasurerService();
    return this.instance;
  }

  static setInstance(next: KRSkillMeasurerService | null): void {
    this.instance = next;
  }

  /**
   * Resolve a bare skill name to its `execute.sh`, searching the known roots.
   *
   * @param skill - Bare directory name
   * @returns Absolute path, or null when the name is invalid or not found
   */
  resolveSkill(skill: string): string | null {
    if (!SKILL_NAME_RE.test(skill)) return null;
    for (const root of this.skillRoots) {
      const candidate = path.join(root, skill, 'execute.sh');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Measure every `skill_output` KR of a mission. Failure-soft: one KR's
   * error never stops the others, and nothing throws to the sweep.
   *
   * @param missionId - Mission whose KRs to measure
   * @returns One outcome per skill_output KR
   */
  async measureMission(missionId: string): Promise<SkillMeasurementOutcome[]> {
    let krs: KeyResult[];
    try {
      krs = await this.krTracking.listByMission(missionId);
    } catch (err) {
      this.logger.warn('Could not list KRs for skill measurement', {
        missionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const outcomes: SkillMeasurementOutcome[] = [];
    for (const kr of krs) {
      if (kr.measurementSource !== 'skill_output') continue;
      outcomes.push(await this.measureOne(missionId, kr));
    }
    return outcomes;
  }

  /**
   * Measure one KR. Exposed for the manual `POST …/measure-now` path.
   *
   * @param missionId - Owning mission
   * @param kr - The KR (must be `skill_output`)
   * @returns The outcome
   */
  async measureOne(missionId: string, kr: KeyResult): Promise<SkillMeasurementOutcome> {
    const cfg = (kr.measurementConfig ?? {}) as Partial<SkillOutputMeasurementConfig>;
    if (typeof cfg.skill !== 'string') {
      return { krId: kr.id, status: 'skipped', reason: 'measurementConfig.skill missing' };
    }
    const executePath = this.resolveSkill(cfg.skill);
    if (!executePath) {
      return { krId: kr.id, status: 'failed', reason: `skill not found: ${cfg.skill}` };
    }
    let stdout: string;
    try {
      stdout = await this.runner(executePath, JSON.stringify(cfg.args ?? {}), KR_SKILL_MEASURER_CONSTANTS.TIMEOUT_MS);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn('skill_output measurement failed', { missionId, krId: kr.id, skill: cfg.skill, reason });
      return { krId: kr.id, status: 'failed', reason };
    }
    let parsed: unknown;
    try {
      const start = stdout.search(/[[{]/);
      parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
    } catch {
      return { krId: kr.id, status: 'failed', reason: 'skill output is not JSON' };
    }
    const value = coerceMeasurement(readJsonPath(parsed, cfg.jsonPath ?? KR_SKILL_MEASURER_CONSTANTS.DEFAULT_JSON_PATH));
    if (value === undefined) {
      return { krId: kr.id, status: 'failed', reason: `no number at ${cfg.jsonPath ?? KR_SKILL_MEASURER_CONSTANTS.DEFAULT_JSON_PATH}` };
    }
    if (kr.measurements.length > 0 && kr.current === value) {
      return { krId: kr.id, status: 'unchanged', value };
    }
    try {
      await this.krTracking.recordMeasurement(missionId, kr.id, value, 'skill_output', `skill ${cfg.skill}`);
    } catch (err) {
      return { krId: kr.id, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
    this.logger.info('KR measured from skill output', { missionId, krId: kr.id, skill: cfg.skill, value });
    return { krId: kr.id, status: 'recorded', value };
  }
}
