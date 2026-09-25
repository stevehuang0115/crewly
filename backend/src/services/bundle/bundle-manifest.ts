/**
 * Solution bundle manifest: validation and normalization.
 *
 * A bundle is an ordinary team template with a `bundle` section
 * (types/solution-bundle.types.ts). This module checks everything the apply
 * engine relies on, so a broken template is refused before anything is
 * written: roles, a lead per team, member refs, placeholders, cron
 * expressions, question shapes, connectors, file paths.
 *
 * @module services/bundle/bundle-manifest
 */

import * as path from 'path';
import { BUNDLE_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { isValidTemplateRole, type TemplateRole } from '../../types/team-template.types.js';
import type {
  BundleQuestion,
  BundleTeamSpec,
  BundleTemplate,
  SolutionBundle,
} from '../../types/solution-bundle.types.js';
import { listPlaceholders } from './bundle-placeholders.js';

/** Result of validating a template's bundle section. */
export interface BundleValidation {
  ok: boolean;
  /** One line per problem, with a JSON-ish path */
  errors: string[];
}

/** A team of the bundle, normalized: the main team plus `bundle.teams`. */
export interface NormalizedBundleTeam {
  key: string;
  /** Name before placeholders are filled */
  name: string;
  description: string;
  roles: TemplateRole[];
  /** Role id of the team's lead (hierarchyLevel 1 + canDelegate) */
  leadRole: string;
}

/** A parsed member reference (`role` or `team/role`). */
export interface MemberRef {
  teamKey: string;
  role: string;
}

/** Optional file access, to check `file` references of norms / SOPs. */
export interface BundleValidationOptions {
  /** Directory relative `file` paths resolve against */
  dir?: string;
  /** Read a file (defaults to none: file contents are not checked) */
  readFile?: (absolutePath: string) => string | null;
}

/** Kebab-case id (file names, keys). */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Question ids double as placeholder names. */
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Session names are built from member names, so they stay ASCII. */
const ASCII_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;
/** `HH:MM`, 24-hour. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** One cron list element: `*`, `n`, `a-b`, with an optional `/step`. */
const CRON_ELEMENT_PATTERN = /^(\*|\d+(-\d+)?)(\/\d+)?$/;
/** Allowed ranges of the five cron fields. */
const CRON_RANGES: ReadonlyArray<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/**
 * Whether a raw template carries a `bundle` section.
 *
 * @param raw - Parsed template JSON
 * @returns True when `bundle` is an object
 */
export function hasBundleSection(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !!(raw as { bundle?: unknown }).bundle && typeof (raw as { bundle?: unknown }).bundle === 'object';
}

/**
 * Check a five-field cron expression (`*`, numbers, ranges, lists, steps).
 *
 * @param expression - Cron expression
 * @returns True when every field is valid and in range
 *
 * @example
 * isValidCronExpression('0 9 * * 1-5') // true
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const [min, max] = CRON_RANGES[i];
    return field.split(',').every((element) => {
      if (!CRON_ELEMENT_PATTERN.test(element)) return false;
      const [range, step] = element.split('/');
      if (step !== undefined && Number(step) < 1) return false;
      if (range === '*') return true;
      const [a, b] = range.split('-').map(Number);
      if (a < min || a > max) return false;
      if (b !== undefined && (b < a || b > max)) return false;
      return true;
    });
  });
}

/**
 * Parse a member reference.
 *
 * @param ref - `role` (main team) or `team/role`
 * @returns The team key and role
 */
export function parseMemberRef(ref: string): MemberRef {
  const slash = ref.indexOf('/');
  if (slash < 0) return { teamKey: BUNDLE_CONSTANTS.MAIN_TEAM_KEY, role: ref };
  return { teamKey: ref.slice(0, slash), role: ref.slice(slash + 1) };
}

/**
 * The lead role of a list of roles: the first with hierarchyLevel 1 that can
 * delegate, else the first role.
 *
 * @param roles - Roles
 * @returns Role id, or '' when there are no roles
 */
export function leadRoleOf(roles: TemplateRole[]): string {
  return (roles.find((r) => r.hierarchyLevel === 1 && r.canDelegate) ?? roles[0])?.role ?? '';
}

/**
 * Every team of a bundle: the template's own roles as the main team, then
 * `bundle.teams`.
 *
 * @param template - A validated bundle template
 * @returns Teams, main first
 */
export function bundleTeams(template: BundleTemplate): NormalizedBundleTeam[] {
  const main: NormalizedBundleTeam = {
    key: BUNDLE_CONSTANTS.MAIN_TEAM_KEY,
    name: template.bundle.teamName ?? template.name,
    description: template.description,
    roles: template.roles,
    leadRole: leadRoleOf(template.roles),
  };
  const extra = (template.bundle.teams ?? []).map((t: BundleTeamSpec) => ({
    key: t.key,
    name: t.name,
    description: t.description ?? '',
    roles: t.roles,
    leadRole: leadRoleOf(t.roles),
  }));
  return [main, ...extra];
}

/**
 * Whether a relative file path stays inside the template directory.
 *
 * @param file - Path from the manifest
 * @returns True for a plain relative path without `..`
 */
function isSafeRelativePath(file: string): boolean {
  if (!file || path.isAbsolute(file)) return false;
  return !file.split(/[\\/]/).includes('..');
}

/**
 * Validate a question list.
 *
 * @param questions - Questions (unknown shape)
 * @param errors - Collects problems
 * @returns The ids of the well-formed questions
 */
function validateQuestions(questions: unknown, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (questions === undefined) return ids;
  if (!Array.isArray(questions)) {
    errors.push('bundle.questions: must be an array');
    return ids;
  }
  questions.forEach((raw, i) => {
    const q = raw as Partial<BundleQuestion>;
    const at = `bundle.questions[${i}]`;
    if (typeof q.id !== 'string' || !QUESTION_ID_PATTERN.test(q.id)) {
      errors.push(`${at}.id: lower snake case required (it is the placeholder name)`);
      return;
    }
    if (ids.has(q.id)) errors.push(`${at}.id: duplicate "${q.id}"`);
    if ((BUNDLE_CONSTANTS.BUILTIN_PLACEHOLDERS as readonly string[]).includes(q.id)) errors.push(`${at}.id: "${q.id}" is a built-in placeholder`);
    ids.add(q.id);
    if (typeof q.label !== 'string' || q.label.trim() === '') errors.push(`${at}.label: required`);
    if (!['text', 'textarea', 'select', 'multiselect'].includes(q.type as string)) errors.push(`${at}.type: text | textarea | select | multiselect`);
    if (typeof q.required !== 'boolean') errors.push(`${at}.required: boolean required`);
    const choice = q.type === 'select' || q.type === 'multiselect';
    const values = new Set<string>();
    if (choice) {
      if (!Array.isArray(q.options) || q.options.length === 0) {
        errors.push(`${at}.options: a ${q.type} question needs options`);
      } else {
        q.options.forEach((o, j) => {
          if (!o || typeof o.value !== 'string' || o.value === '') errors.push(`${at}.options[${j}].value: required`);
          else values.add(o.value);
        });
      }
    }
    if (q.required === false && q.default === undefined) {
      errors.push(`${at}.default: an optional question needs a default (may be "")`);
    }
    if (q.default !== undefined) {
      const defaults = Array.isArray(q.default) ? q.default : [q.default];
      if (!defaults.every((d) => typeof d === 'string')) errors.push(`${at}.default: string or string[]`);
      if (choice && values.size > 0) {
        const bad = defaults.filter((d) => d !== '' && !values.has(d));
        if (bad.length > 0) errors.push(`${at}.default: not an option: ${bad.join(', ')}`);
      }
      if (q.type === 'select' && Array.isArray(q.default)) errors.push(`${at}.default: a select default is one value`);
    }
  });
  return ids;
}

/**
 * Validate the roles of one team.
 *
 * @param roles - Roles (unknown shape)
 * @param at - Path for messages
 * @param errors - Collects problems
 * @returns Role ids of the well-formed roles
 */
function validateRoles(roles: unknown, at: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(roles) || roles.length === 0) {
    errors.push(`${at}: at least one role (the "roles" format; members[] templates cannot be bundles)`);
    return ids;
  }
  const names = new Set<string>();
  roles.forEach((raw, i) => {
    if (!isValidTemplateRole(raw)) {
      errors.push(`${at}[${i}]: needs role, label, defaultName, count ≥ 1, hierarchyLevel, canDelegate, defaultSkills`);
      return;
    }
    if (ids.has(raw.role)) errors.push(`${at}[${i}].role: duplicate "${raw.role}"`);
    ids.add(raw.role);
    if (!ASCII_NAME_PATTERN.test(raw.defaultName)) {
      errors.push(`${at}[${i}].defaultName: ASCII letters, digits, space, - or _ (session names are built from it); put the Chinese title in jobTitle`);
    }
    const lower = raw.defaultName.toLowerCase();
    if (names.has(lower)) errors.push(`${at}[${i}].defaultName: duplicate "${raw.defaultName}"`);
    names.add(lower);
  });
  const typed = roles.filter(isValidTemplateRole);
  if (typed.length > 0 && !typed.some((r) => r.hierarchyLevel === 1 && r.canDelegate)) {
    errors.push(`${at}: one role must be the lead (hierarchyLevel 1, canDelegate true)`);
  }
  for (const r of typed) {
    if (r.reportsTo && !ids.has(r.reportsTo)) errors.push(`${at}: "${r.role}" reports to unknown role "${r.reportsTo}"`);
  }
  return ids;
}

/**
 * Validate a template that carries a `bundle` section.
 *
 * @param raw - Parsed template JSON
 * @param options - File access for `file` references (optional)
 * @returns `{ ok, errors }`
 *
 * @example
 * const { ok, errors } = validateBundleTemplate(JSON.parse(text), { dir, readFile });
 */
export function validateBundleTemplate(raw: unknown, options: BundleValidationOptions = {}): BundleValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['template: must be an object'] };
  const t = raw as Partial<BundleTemplate> & Record<string, unknown>;
  if (typeof t.id !== 'string' || !SLUG_PATTERN.test(t.id)) errors.push('id: kebab-case required');
  if (typeof t.name !== 'string' || t.name.trim() === '') errors.push('name: required');
  if (typeof t.description !== 'string') errors.push('description: required');
  if (!hasBundleSection(t)) {
    errors.push('bundle: section required');
    return { ok: false, errors };
  }
  const b = t.bundle as Partial<SolutionBundle>;

  if (b.schemaVersion !== BUNDLE_CONSTANTS.SCHEMA_VERSION) errors.push(`bundle.schemaVersion: must be ${BUNDLE_CONSTANTS.SCHEMA_VERSION}`);
  if (b.status !== undefined && !Object.values(BUNDLE_CONSTANTS.STATUS).includes(b.status)) errors.push('bundle.status: ready | draft');
  for (const key of ['label', 'tagline', 'ownerSummary'] as const) {
    if (typeof b[key] !== 'string' || (b[key] as string).trim() === '') errors.push(`bundle.${key}: required`);
  }
  const runtimes = Object.values(RUNTIME_TYPES) as string[];
  if (!b.runtime || !runtimes.includes(b.runtime.recommended)) {
    errors.push(`bundle.runtime.recommended: one of ${runtimes.join(', ')}`);
  } else if (b.runtime.compatible && !b.runtime.compatible.every((r) => runtimes.includes(r))) {
    errors.push('bundle.runtime.compatible: unknown runtime');
  }
  if (!b.server || !BUNDLE_CONSTANTS.SERVER_TIERS.includes(b.server.tier)) {
    errors.push(`bundle.server.tier: one of ${BUNDLE_CONSTANTS.SERVER_TIERS.join(', ')}`);
  }

  // Teams and roles
  const mainRoles = validateRoles(t.roles, 'roles', errors);
  const rolesByTeam = new Map<string, Set<string>>([[BUNDLE_CONSTANTS.MAIN_TEAM_KEY, mainRoles]]);
  if (b.teams !== undefined) {
    if (!Array.isArray(b.teams)) errors.push('bundle.teams: must be an array');
    else {
      b.teams.forEach((team, i) => {
        const at = `bundle.teams[${i}]`;
        if (!team || typeof team.key !== 'string' || !SLUG_PATTERN.test(team.key)) {
          errors.push(`${at}.key: kebab-case required`);
          return;
        }
        if (rolesByTeam.has(team.key)) errors.push(`${at}.key: duplicate "${team.key}" (main is reserved)`);
        if (typeof team.name !== 'string' || team.name.trim() === '') errors.push(`${at}.name: required`);
        rolesByTeam.set(team.key, validateRoles(team.roles, `${at}.roles`, errors));
      });
    }
  }

  const questionIds = validateQuestions(b.questions, errors);
  const known = new Set<string>([...questionIds, ...BUNDLE_CONSTANTS.BUILTIN_PLACEHOLDERS]);
  const checkText = (text: unknown, at: string): void => {
    if (typeof text !== 'string') return;
    const unknown = listPlaceholders(text).filter((p) => !known.has(p));
    if (unknown.length > 0) errors.push(`${at}: placeholder without a question: {{${unknown.join('}}, {{')}}}`);
  };
  const checkRef = (ref: unknown, at: string, allowStar = false): void => {
    if (typeof ref !== 'string' || ref === '') {
      errors.push(`${at}: member ref required`);
      return;
    }
    if (allowStar && ref === '*') return;
    const { teamKey, role } = parseMemberRef(ref);
    const roles = rolesByTeam.get(teamKey);
    if (!roles) errors.push(`${at}: unknown team "${teamKey}"`);
    else if (!roles.has(role)) errors.push(`${at}: unknown role "${role}" in team "${teamKey}"`);
  };
  const checkTeamKey = (key: unknown, at: string): void => {
    if (key !== undefined && (typeof key !== 'string' || !rolesByTeam.has(key))) errors.push(`${at}: unknown team "${String(key)}"`);
  };

  // Placeholders in prompts and names
  checkText(b.teamName, 'bundle.teamName');
  checkText(b.timezone, 'bundle.timezone');
  checkText(t.mission, 'mission');
  const allRoleLists: Array<[string, unknown]> = [['roles', t.roles], ...(Array.isArray(b.teams) ? b.teams.map((team, i) => [`bundle.teams[${i}].roles`, team?.roles] as [string, unknown]) : [])];
  for (const [at, roles] of allRoleLists) {
    if (!Array.isArray(roles)) continue;
    roles.forEach((r: Partial<TemplateRole>, i) => {
      checkText(r?.promptAdditions, `${at}[${i}].promptAdditions`);
      checkText(r?.jobDescription, `${at}[${i}].jobDescription`);
    });
  }
  if (Array.isArray(b.teams)) {
    b.teams.forEach((team, i) => {
      checkText(team?.name, `bundle.teams[${i}].name`);
      checkText(team?.description, `bundle.teams[${i}].description`);
    });
  }

  // Norms and SOPs
  const docLists: Array<['norms' | 'sops', unknown]> = [['norms', b.norms], ['sops', b.sops]];
  for (const [kind, list] of docLists) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`bundle.${kind}: must be an array`);
      continue;
    }
    const seen = new Set<string>();
    list.forEach((doc: { id?: unknown; title?: unknown; content?: unknown; file?: unknown; team?: unknown; category?: unknown }, i) => {
      const at = `bundle.${kind}[${i}]`;
      if (typeof doc?.id !== 'string' || !SLUG_PATTERN.test(doc.id)) errors.push(`${at}.id: kebab-case required`);
      else {
        const key = `${String(doc.team ?? BUNDLE_CONSTANTS.MAIN_TEAM_KEY)}/${String(doc.category ?? '')}/${doc.id}`;
        if (seen.has(key)) errors.push(`${at}.id: duplicate "${doc.id}"`);
        seen.add(key);
        if (kind === 'norms' && doc.id === BUNDLE_CONSTANTS.REVIEW_POINTS_NORM_ID) errors.push(`${at}.id: "${doc.id}" is written from reviewPoints`);
      }
      if (typeof doc?.title !== 'string' || doc.title.trim() === '') errors.push(`${at}.title: required`);
      if (doc?.category !== undefined && (typeof doc.category !== 'string' || !SLUG_PATTERN.test(doc.category))) errors.push(`${at}.category: kebab-case`);
      checkTeamKey(doc?.team, `${at}.team`);
      const hasContent = typeof doc?.content === 'string' && doc.content.trim() !== '';
      const hasFile = typeof doc?.file === 'string';
      if (hasContent === hasFile) {
        errors.push(`${at}: exactly one of content / file`);
        return;
      }
      if (hasContent) checkText(doc.content, `${at}.content`);
      if (hasFile) {
        const file = doc.file as string;
        if (!isSafeRelativePath(file)) {
          errors.push(`${at}.file: relative path inside the template directory`);
          return;
        }
        if (options.dir && options.readFile) {
          const body = options.readFile(path.join(options.dir, file));
          if (body === null) errors.push(`${at}.file: not found: ${file}`);
          else checkText(body, `${at}.file ${file}`);
        }
      }
    });
  }

  // Review points
  if (b.reviewPoints !== undefined) {
    if (!Array.isArray(b.reviewPoints)) errors.push('bundle.reviewPoints: must be an array');
    else b.reviewPoints.forEach((rp, i) => {
      const at = `bundle.reviewPoints[${i}]`;
      if (typeof rp?.id !== 'string' || !SLUG_PATTERN.test(rp.id)) errors.push(`${at}.id: kebab-case required`);
      if (typeof rp?.what !== 'string' || rp.what.trim() === '') errors.push(`${at}.what: required`);
      if (rp?.approver !== 'owner' && rp?.approver !== 'lead') errors.push(`${at}.approver: owner | lead`);
      checkText(rp?.what, `${at}.what`);
      checkText(rp?.how, `${at}.how`);
      checkTeamKey(rp?.team, `${at}.team`);
    });
  }

  // Skills
  if (b.skills !== undefined) {
    const lists = [['required', b.skills?.required], ['optional', b.skills?.optional ?? []]] as const;
    for (const [key, list] of lists) {
      if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && SLUG_PATTERN.test(s))) {
        errors.push(`bundle.skills.${key}: array of skill ids`);
      }
    }
  }

  // Connectors
  if (b.connectors !== undefined) {
    if (!Array.isArray(b.connectors)) errors.push('bundle.connectors: must be an array');
    else b.connectors.forEach((c, i) => {
      const at = `bundle.connectors[${i}]`;
      if (!c || !BUNDLE_CONSTANTS.CONNECTOR_IDS.includes(c.id)) errors.push(`${at}.id: one of ${BUNDLE_CONSTANTS.CONNECTOR_IDS.join(', ')}`);
      if (typeof c?.required !== 'boolean') errors.push(`${at}.required: boolean required`);
      if (typeof c?.why !== 'string' || c.why.trim() === '') errors.push(`${at}.why: required (owner-facing)`);
      if (c?.products !== undefined) {
        if (c.id !== 'google-workspace') errors.push(`${at}.products: only for google-workspace`);
        else if (!Array.isArray(c.products) || !c.products.every((p) => BUNDLE_CONSTANTS.GOOGLE_PRODUCTS.includes(p))) {
          errors.push(`${at}.products: ${BUNDLE_CONSTANTS.GOOGLE_PRODUCTS.join(' | ')}`);
        }
      }
    });
  }

  // Slack
  if (b.slack !== undefined) {
    const channels = b.slack?.channels ?? [];
    if (!Array.isArray(channels)) errors.push('bundle.slack.channels: must be an array');
    else {
      const keys = new Set<string>();
      channels.forEach((ch, i) => {
        const at = `bundle.slack.channels[${i}]`;
        if (typeof ch?.key !== 'string' || !SLUG_PATTERN.test(ch.key)) errors.push(`${at}.key: kebab-case required`);
        else if (keys.has(ch.key)) errors.push(`${at}.key: duplicate "${ch.key}"`);
        else keys.add(ch.key);
        if (typeof ch?.name !== 'string' || ch.name.trim() === '') errors.push(`${at}.name: required`);
        checkText(ch?.name, `${at}.name`);
        checkText(ch?.purpose, `${at}.purpose`);
        if (!Array.isArray(ch?.members) || ch.members.length === 0) errors.push(`${at}.members: at least one ref or "*"`);
        else ch.members.forEach((ref, j) => checkRef(ref, `${at}.members[${j}]`, true));
      });
    }
  }

  // Schedules
  if (b.schedules !== undefined) {
    if (!Array.isArray(b.schedules)) errors.push('bundle.schedules: must be an array');
    else {
      const ids = new Set<string>();
      b.schedules.forEach((s, i) => {
        const at = `bundle.schedules[${i}]`;
        if (typeof s?.id !== 'string' || !SLUG_PATTERN.test(s.id)) errors.push(`${at}.id: kebab-case required`);
        else if (ids.has(s.id)) errors.push(`${at}.id: duplicate "${s.id}"`);
        else ids.add(s.id);
        if (typeof s?.title !== 'string' || s.title.trim() === '') errors.push(`${at}.title: required`);
        if (typeof s?.cron !== 'string' || !isValidCronExpression(s.cron)) errors.push(`${at}.cron: five-field cron expression`);
        if (typeof s?.task !== 'string' || s.task.trim() === '') errors.push(`${at}.task: required`);
        checkText(s?.task, `${at}.task`);
        checkText(s?.timezone, `${at}.timezone`);
        if (s?.target !== undefined) checkRef(s.target, `${at}.target`);
      });
    }
  }

  // First week
  if (b.firstWeek !== undefined) {
    if (!Array.isArray(b.firstWeek)) errors.push('bundle.firstWeek: must be an array');
    else {
      const ids = new Set<string>();
      b.firstWeek.forEach((task, i) => {
        const at = `bundle.firstWeek[${i}]`;
        if (typeof task?.id !== 'string' || !SLUG_PATTERN.test(task.id)) errors.push(`${at}.id: kebab-case required`);
        else if (ids.has(task.id)) errors.push(`${at}.id: duplicate "${task.id}"`);
        else ids.add(task.id);
        if (!Number.isInteger(task?.day) || task.day < 0 || task.day > BUNDLE_CONSTANTS.MAX_FIRST_WEEK_DAY) {
          errors.push(`${at}.day: integer 0-${BUNDLE_CONSTANTS.MAX_FIRST_WEEK_DAY}`);
        }
        if (task?.time !== undefined && (typeof task.time !== 'string' || !TIME_PATTERN.test(task.time))) errors.push(`${at}.time: HH:MM`);
        if (typeof task?.title !== 'string' || task.title.trim() === '') errors.push(`${at}.title: required`);
        if (typeof task?.task !== 'string' || task.task.trim() === '') errors.push(`${at}.task: required`);
        checkText(task?.title, `${at}.title`);
        checkText(task?.task, `${at}.task`);
        if (task?.target !== undefined) checkRef(task.target, `${at}.target`);
      });
    }
  }

  if (b.todo !== undefined && (!Array.isArray(b.todo) || !b.todo.every((x) => typeof x === 'string'))) {
    errors.push('bundle.todo: array of strings');
  }

  return { ok: errors.length === 0, errors };
}
