/**
 * WhatsApp Service
 *
 * Manages WhatsApp connection via Baileys (WhatsApp Web multi-device protocol).
 * Handles QR code pairing, auth state persistence, and bidirectional messaging.
 *
 * @module services/whatsapp
 */

import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import type {
  WhatsAppConfig,
  WhatsAppIncomingMessage,
  WhatsAppOutgoingMessage,
  WhatsAppServiceStatus,
  WhatsAppConversationContext,
} from '../../types/whatsapp.types.js';
import { isContactAllowed } from '../../types/whatsapp.types.js';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

/**
 * Events emitted by WhatsAppService
 */
export interface WhatsAppServiceEvents {
  message: (message: WhatsAppIncomingMessage) => void;
  qr: (qrCode: string) => void;
  connected: () => void;
  disconnected: (reason?: string) => void;
  error: (error: Error) => void;
}

/**
 * Baileys socket type (minimal interface to avoid tight coupling)
 */
interface BaileysSocket {
  sendMessage: (jid: string, content: Record<string, unknown>) => Promise<unknown>;
  logout: () => Promise<void>;
  end: (error?: Error) => void;
  ev: EventEmitter;
  user?: { id: string; name?: string };
}

/**
 * WhatsApp Service singleton
 *
 * Manages the Baileys WebSocket connection, QR pairing flow,
 * and message send/receive lifecycle.
 *
 * @example
 * ```typescript
 * const service = getWhatsAppService();
 * await service.initialize({ allowedContacts: ['+1234567890'] });
 * service.on('message', (msg) => console.log(msg.text));
 * ```
 */
export class WhatsAppService extends EventEmitter {
  private logger = LoggerService.getInstance().createComponentLogger('WhatsAppService');
  private sock: BaileysSocket | null = null;
  private config: WhatsAppConfig | null = null;
  private connected = false;
  private currentQrCode: string | null = null;
  private messagesSent = 0;
  private messagesReceived = 0;
  private phoneNumber: string | null = null;
  private conversationContexts: Map<string, WhatsAppConversationContext> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private static readonly MAX_RECONNECT_DELAY_MS = 60000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;

  /**
   * Initialize the WhatsApp connection.
   * Sets up Baileys socket, auth state persistence, and event handlers.
   *
   * @param config - WhatsApp configuration
   */
  async initialize(config: WhatsAppConfig): Promise<void> {
    this.config = config;

    // Clean up existing socket listeners before re-initializing (prevents leaks on reconnect)
    if (this.sock) {
      this.sock.ev.removeAllListeners();
    }

    const authDir = config.authStatePath || path.join(os.homedir(), '.crewly', WHATSAPP_CONSTANTS.AUTH_DIR);
    await fs.mkdir(authDir, { recursive: true });

    try {
      // Dynamic import for Baileys (ESM/CJS compatibility).
      //
      // baileys is declared as an `optionalDependencies` in package.json and
      // may legitimately be absent at install time (skipped optional, platform
      // mismatch, or deliberate `--omit=optional`). We route the specifier
      // through a string variable so TypeScript does not try to statically
      // resolve the module — the typecheck passes whether `node_modules/
      // @whiskeysockets/baileys` exists or not. Any actual missing-module
      // failure surfaces at runtime via the surrounding try/catch.
      const BAILEYS_MODULE = '@whiskeysockets/baileys';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const baileys: any = await import(BAILEYS_MODULE);
      const makeWASocket = baileys.default?.default ?? baileys.default ?? baileys.makeWASocket;
      const useMultiFileAuthState = baileys.useMultiFileAuthState ?? baileys.default?.useMultiFileAuthState;
      const DisconnectReason = baileys.DisconnectReason ?? baileys.default?.DisconnectReason;

      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
      });

      this.sock = sock as unknown as BaileysSocket;

      // Save credentials on update
      sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      sock.ev.on('connection.update', (update: Record<string, unknown>) => {
        const { connection, lastDisconnect, qr } = update as {
          connection?: string;
          lastDisconnect?: { error?: { output?: { statusCode?: number } } };
          qr?: string;
        };

        if (qr) {
          this.currentQrCode = qr;
          this.logger.info('QR code generated — scan to pair');
          this.emit('qr', qr);
        }

        if (connection === 'close') {
          this.connected = false;
          this.currentQrCode = null;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;

          if (shouldReconnect) {
            // Exponential backoff: 5s, 10s, 20s, 40s, ... up to MAX_RECONNECT_DELAY_MS
            const delay = Math.min(
              WHATSAPP_CONSTANTS.RECONNECT_INTERVAL_MS * Math.pow(2, this.reconnectAttempts),
              WhatsAppService.MAX_RECONNECT_DELAY_MS,
            );
            this.reconnectAttempts++;

            this.logger.info('Connection closed, reconnecting...', {
              statusCode,
              attempt: this.reconnectAttempts,
              delayMs: delay,
            });

            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
            }

            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.initialize(config).catch((err) => {
                const error = err instanceof Error ? err : new Error(String(err));
                this.logger.error('Reconnection failed', {
                  error: error.message,
                  attempt: this.reconnectAttempts,
                });
                this.emit('error', error);

                if (this.reconnectAttempts >= WhatsAppService.MAX_RECONNECT_ATTEMPTS) {
                  this.logger.error('Max reconnection attempts reached, giving up');
                  this.reconnectAttempts = 0;
                  this.emit('disconnected', 'max_retries_exceeded');
                }
              });
            }, delay);
          } else {
            this.logger.info('Logged out, not reconnecting');
            this.reconnectAttempts = 0;
            this.emit('disconnected', 'logged_out');
          }
        }

        if (connection === 'open') {
          this.connected = true;
          this.currentQrCode = null;
          this.reconnectAttempts = 0;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.phoneNumber = (sock as unknown as BaileysSocket).user?.id?.split(':')[0] || config.phoneNumber || null;
          this.logger.info('Connected', { phoneNumber: this.phoneNumber });
          this.emit('connected');
        }
      });

      // Handle incoming messages
      sock.ev.on('messages.upsert', (upsert: { messages: Array<Record<string, unknown>>; type: string }) => {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
          this.handleIncomingMessage(msg);
        }
      });

      this.logger.info('Initialized — waiting for connection');
    } catch (error) {
      this.logger.error('Failed to initialize', { error: error instanceof Error ? error.message : String(error) });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Process an incoming Baileys message and emit as WhatsAppIncomingMessage.
   *
   * Extracts text from various WhatsApp message types (conversation, extendedTextMessage),
   * validates the sender against the allowed contacts list, and emits a normalized
   * message event for the bridge to handle.
   *
   * Messages are silently ignored if:
   * - Sent by this account (fromMe = true)
   * - No text content present (images, stickers, etc.)
   * - Sender not in allowedContacts list (when configured)
   *
   * @param rawMsg - Raw Baileys message object containing key, message content, and metadata
   */
  private handleIncomingMessage(rawMsg: Record<string, unknown>): void {
    try {
      const key = rawMsg.key as { remoteJid?: string; fromMe?: boolean; id?: string } | undefined;
      if (!key?.remoteJid || key.fromMe) return;

      const messageContent = rawMsg.message as Record<string, unknown> | undefined;
      if (!messageContent) return;

      // Extract text from various message types
      const text =
        (messageContent.conversation as string) ||
        (messageContent.extendedTextMessage as { text?: string } | undefined)?.text ||
        '';

      if (!text) return;

      const chatId = key.remoteJid;
      const isGroup = chatId.endsWith('@g.us');

      // Check contact permissions
      if (this.config && !isContactAllowed(chatId, this.config)) {
        this.logger.info('Ignoring message from non-allowed contact', { chatId });
        return;
      }

      const contactName = (rawMsg.pushName as string) || chatId.split('@')[0];

      const message: WhatsAppIncomingMessage = {
        messageId: key.id || '',
        chatId,
        from: chatId,
        text,
        isGroup,
        contactName,
        timestamp: (rawMsg.messageTimestamp as number) || Math.floor(Date.now() / 1000),
      };

      this.messagesReceived++;
      this.logger.info('Received message', {
        from: contactName,
        preview: text.substring(0, 50),
      });
      this.emit('message', message);
    } catch (error) {
      this.logger.error('Error processing incoming message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send a text message via WhatsApp.
   *
   * @param msg - Outgoing message with destination and text
   * @throws Error if not connected or message too long
   */
  async sendMessage(msg: WhatsAppOutgoingMessage): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error('WhatsApp is not connected');
    }

    if (msg.text.length > WHATSAPP_CONSTANTS.MAX_MESSAGE_LENGTH) {
      throw new Error(`Message exceeds maximum length of ${WHATSAPP_CONSTANTS.MAX_MESSAGE_LENGTH} characters`);
    }

    await this.sock.sendMessage(msg.to, { text: msg.text });
    this.messagesSent++;
    this.logger.info('Sent message', { to: msg.to, length: msg.text.length });
  }

  /**
   * Send a file (document) via WhatsApp.
   *
   * @param chatId - Destination chat JID
   * @param filePath - Absolute path to the file on disk
   * @param caption - Optional caption for the file
   * @throws Error if not connected or file too large
   */
  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error('WhatsApp is not connected');
    }

    const stat = await fs.stat(filePath);
    if (stat.size > WHATSAPP_CONSTANTS.MAX_FILE_SIZE) {
      const maxMB = Math.round(WHATSAPP_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024));
      throw new Error(`File too large (max ${maxMB} MB)`);
    }

    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    await this.sock.sendMessage(chatId, {
      document: fileBuffer,
      fileName,
      caption: caption || '',
    });
    this.messagesSent++;
    this.logger.info('Sent file', { to: chatId, fileName });
  }

  /**
   * Disconnect from WhatsApp gracefully.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (error) {
        this.logger.warn('Error during disconnect', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.sock = null;
      this.connected = false;
      this.currentQrCode = null;
      this.logger.info('Disconnected');
      this.emit('disconnected', 'manual');
    }
  }

  /**
   * Get current connection status.
   *
   * @returns WhatsApp service status object
   */
  getStatus(): WhatsAppServiceStatus {
    return {
      connected: this.connected,
      qrCode: this.currentQrCode,
      phoneNumber: this.phoneNumber,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
    };
  }

  /**
   * Check if WhatsApp is currently connected.
   *
   * @returns True if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the current QR code for pairing.
   *
   * @returns QR code string or null if not pending
   */
  getQRCode(): string | null {
    return this.currentQrCode;
  }

  /**
   * Get or create a conversation context for a chat.
   *
   * @param chatId - Chat JID
   * @param contactName - Contact display name
   * @returns Conversation context for message routing
   */
  getConversationContext(chatId: string, contactName: string): WhatsAppConversationContext {
    let context = this.conversationContexts.get(chatId);
    if (!context) {
      context = {
        chatId,
        contactName,
        conversationId: `whatsapp-${chatId}`,
        messageCount: 0,
      };
      this.conversationContexts.set(chatId, context);
    }
    context.messageCount++;
    return context;
  }
}

/** WhatsApp service singleton instance */
let whatsappServiceInstance: WhatsAppService | null = null;

/**
 * Get WhatsApp service singleton
 *
 * @returns WhatsAppService instance
 */
export function getWhatsAppService(): WhatsAppService {
  if (!whatsappServiceInstance) {
    whatsappServiceInstance = new WhatsAppService();
  }
  return whatsappServiceInstance;
}

/**
 * Reset WhatsApp service singleton (for testing)
 */
export function resetWhatsAppService(): void {
  whatsappServiceInstance = null;
}
