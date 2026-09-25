/**
 * WhatsApp Service Module
 *
 * Exports the WhatsApp service for bot integration via Baileys.
 *
 * @module services/whatsapp
 */

export { WhatsAppService, getWhatsAppService, resetWhatsAppService } from './whatsapp.service.js';
export {
  WhatsAppOrchestratorBridge,
  getWhatsAppOrchestratorBridge,
  resetWhatsAppOrchestratorBridge,
  type WhatsAppBridgeConfig,
} from './whatsapp-orchestrator-bridge.js';
export {
  initializeWhatsAppIfConfigured,
  isWhatsAppConfigured,
  getWhatsAppConfigFromEnv,
  getWhatsAppModeFromEnv,
  resolveStartupWhatsAppConfig,
  applyBridgeForMode,
  shutdownWhatsApp,
  type WhatsAppInitResult,
  type WhatsAppInitOptions,
} from './whatsapp-initializer.js';
export {
  WhatsAppInboxStore,
  getWhatsAppInboxStore,
  resetWhatsAppInboxStore,
  getDefaultInboxDbPath,
} from './whatsapp-inbox.store.js';
export { WhatsAppInboxCapture } from './whatsapp-inbox-capture.js';
export { decideDraftSend, isConfirmationFor } from './whatsapp-draft-gate.js';
export {
  loadWhatsAppConnection,
  saveWhatsAppConnection,
  markWhatsAppDisconnected,
  type PersistedWhatsAppConnection,
} from './whatsapp-connection-config.js';
