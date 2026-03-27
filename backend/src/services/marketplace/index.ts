/**
 * Marketplace Services
 *
 * Exports for marketplace registry browsing, item installation,
 * and local manifest management.
 *
 * @module services/marketplace
 */

// Marketplace registry and browsing
export {
  fetchRegistry,
  loadManifest,
  saveManifest,
  getItem,
  listItems,
  getUpdatableItems,
  getInstalledItems,
  searchItems,
  getInstallPath,
  resetRegistryCache,
  getItemReadme,
} from './marketplace.service.js';

// Marketplace installation operations
export {
  installItem,
  uninstallItem,
  updateItem,
} from './marketplace-installer.service.js';

// Marketplace submission operations
export {
  submitSkill,
  listSubmissions,
  getSubmission,
  reviewSubmission,
  loadSubmissionsManifest,
  saveSubmissionsManifest,
} from './marketplace-submission.service.js';

// Template marketplace operations
export {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  archiveTemplate,
  addVersion,
  listVersions,
  publishTemplate,
  deleteTemplate,
  loadTemplateStore,
  saveTemplateStore,
  loadVersionStore,
  saveVersionStore,
} from './template-marketplace.service.js';
