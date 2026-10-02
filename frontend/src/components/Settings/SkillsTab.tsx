/**
 * SkillsTab — moved.
 *
 * Settings › Skills now lives at Marketplace › Installed
 * (`components/Marketplace/InstalledSkills`). This re-export keeps old
 * imports compiling; new code imports InstalledSkills directly.
 *
 * @deprecated Use `InstalledSkills` from `components/Marketplace/InstalledSkills`.
 * @module components/Settings/SkillsTab
 */

export { InstalledSkills as SkillsTab } from '../Marketplace/InstalledSkills';
export { InstalledSkills as default } from '../Marketplace/InstalledSkills';
