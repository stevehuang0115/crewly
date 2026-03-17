/**
 * Telegram Thread Store Service
 *
 * Persists Telegram chat conversations as markdown files so the
 * orchestrator can read conversation history after restart.
 *
 * Storage layout:
 *   ~/.crewly/telegram-threads/
 *     {chatId}.md          — Chat conversation file
 *
 * @module services/telegram/telegram-thread-store
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { formatMessageTimestamp } from '../../utils/format-date.js';

/** Storage directory name for Telegram threads */
const STORAGE_DIR = 'telegram-threads';

/** File extension for thread files */
const FILE_EXTENSION = '.md';

/**
 * TelegramThreadStoreService manages persistent storage of Telegram
 * chat conversations as markdown files.
 *
 * @example
 * ```typescript
 * const store = new TelegramThreadStoreService();
 * await store.appendUserMessage('12345', 'Alice', 'Hello bot!');
 * await store.appendBotReply('12345', 'Hello Alice!');
 * ```
 */
export class TelegramThreadStoreService {
	private baseDir: string;

	/**
	 * Create a new TelegramThreadStoreService.
	 *
	 * @param crewlyHome - Base crewly home directory (defaults to ~/.crewly)
	 */
	constructor(crewlyHome?: string) {
		const home = crewlyHome || path.join(os.homedir(), '.crewly');
		this.baseDir = path.join(home, STORAGE_DIR);
	}

	/**
	 * Compute the file path for a chat conversation file.
	 *
	 * @param chatId - Telegram chat ID
	 * @returns Absolute path to the chat markdown file
	 */
	getChatFilePath(chatId: string): string {
		// Sanitize chatId (remove any non-alphanumeric/dash/underscore characters)
		const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
		return path.join(this.baseDir, `${safeChatId}${FILE_EXTENSION}`);
	}

	/**
	 * Ensure the chat file exists, creating it with frontmatter if needed.
	 *
	 * @param chatId - Telegram chat ID
	 * @param userName - Name of the user who started the conversation
	 * @returns Absolute path to the chat file
	 */
	async ensureChatFile(chatId: string, userName: string): Promise<string> {
		const filePath = this.getChatFilePath(chatId);
		const dir = path.dirname(filePath);

		await fs.mkdir(dir, { recursive: true });

		try {
			await fs.access(filePath);
		} catch {
			// File doesn't exist — create with frontmatter
			const frontmatter = [
				'---',
				`chatId: ${chatId}`,
				`user: ${userName}`,
				`started: ${new Date().toISOString()}`,
				'---',
				'',
				'## Messages',
				'',
			].join('\n');

			await fs.writeFile(filePath, frontmatter, 'utf-8');
		}

		return filePath;
	}

	/**
	 * Append a user message to the chat conversation file.
	 *
	 * @param chatId - Telegram chat ID
	 * @param userName - Display name of the sender
	 * @param message - Message content
	 */
	async appendUserMessage(
		chatId: string,
		userName: string,
		message: string
	): Promise<void> {
		const filePath = await this.ensureChatFile(chatId, userName);
		const timestamp = formatMessageTimestamp();
		const entry = `\n**${userName}** (${timestamp}):\n${message}\n`;
		await fs.appendFile(filePath, entry, 'utf-8');
	}

	/**
	 * Append a bot reply to the chat conversation file.
	 *
	 * @param chatId - Telegram chat ID
	 * @param message - Bot response content
	 */
	async appendBotReply(chatId: string, message: string): Promise<void> {
		const filePath = this.getChatFilePath(chatId);

		try {
			await fs.access(filePath);
		} catch {
			// Chat file doesn't exist — skip silently
			return;
		}

		const timestamp = formatMessageTimestamp();
		const entry = `\n**Crewly** (${timestamp}):\n${message}\n`;
		await fs.appendFile(filePath, entry, 'utf-8');
	}

	/**
	 * Read the latest conversation thread file path for a given chat.
	 *
	 * @param chatId - Telegram chat ID
	 * @returns Path to the thread file, or null if not found
	 */
	async getLatestThreadPath(chatId: string): Promise<string | null> {
		const filePath = this.getChatFilePath(chatId);
		try {
			await fs.access(filePath);
			return filePath;
		} catch {
			return null;
		}
	}
}

/** Singleton instance */
let instance: TelegramThreadStoreService | null = null;

/**
 * Get the TelegramThreadStoreService singleton.
 *
 * @returns The service instance or null if not initialized
 */
export function getTelegramThreadStore(): TelegramThreadStoreService | null {
	return instance;
}

/**
 * Set the TelegramThreadStoreService singleton.
 *
 * @param store - The service instance to set
 */
export function setTelegramThreadStore(store: TelegramThreadStoreService): void {
	instance = store;
}

/**
 * Reset the TelegramThreadStoreService singleton (for testing).
 */
export function resetTelegramThreadStore(): void {
	instance = null;
}
