/**
 * Labels and options shared by Marketplace › Installed (former Settings ›
 * Skills) and its editor.
 *
 * @module components/Marketplace/skill-ui.constants
 */

import { getSkillCategoryLabel, SKILL_CATEGORIES, type SkillCategory } from '../../types/skill.types';

/** Category options, "All categories" first (value ''). */
export const SKILL_CATEGORY_OPTIONS: { value: SkillCategory | ''; label: string }[] = [
  { value: '', label: 'All Categories' },
  ...SKILL_CATEGORIES.map((cat) => ({ value: cat, label: getSkillCategoryLabel(cat) })),
];

/** Installed rows visible before "Show all N". */
export const INSTALLED_LIST_LIMIT = 5;
