import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('fs', () => ({
	promises: {
		mkdir: jest.fn<(path: string, opts?: unknown) => Promise<void>>().mockResolvedValue(undefined),
		access: jest.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
		writeFile: jest.fn<(path: string, data: string, enc?: string) => Promise<void>>().mockResolvedValue(undefined),
		appendFile: jest.fn<(path: string, data: string, enc?: string) => Promise<void>>().mockResolvedValue(undefined),
	},
}));

jest.mock('../../utils/format-date.js', () => ({
	formatMessageTimestamp: () => '2026-03-17 01:00',
}));

import { promises as fsPromises } from 'fs';
import {
	TelegramThreadStoreService,
	getTelegramThreadStore,
	setTelegramThreadStore,
	resetTelegramThreadStore,
} from './telegram-thread-store.service.js';

describe('TelegramThreadStoreService', () => {
	let store: TelegramThreadStoreService;

	beforeEach(() => {
		jest.clearAllMocks();
		store = new TelegramThreadStoreService('/test/.crewly');
		resetTelegramThreadStore();
	});

	describe('getChatFilePath', () => {
		it('should return a path under the base directory', () => {
			const filePath = store.getChatFilePath('12345');
			expect(filePath).toContain('telegram-threads');
			expect(filePath).toContain('12345');
			expect(filePath).toMatch(/\.md$/);
		});

		it('should sanitize chat IDs with special characters', () => {
			const filePath = store.getChatFilePath('-100123/abc');
			expect(filePath).not.toContain('/abc.');
			expect(filePath).toContain('-100123_abc');
		});
	});

	describe('ensureChatFile', () => {
		it('should create directory and write frontmatter for new chat', async () => {
			(fsPromises.access as jest.MockedFunction<typeof fsPromises.access>)
				.mockRejectedValueOnce(new Error('ENOENT'));

			await store.ensureChatFile('12345', 'Alice');

			expect(fsPromises.mkdir).toHaveBeenCalledWith(
				expect.any(String),
				{ recursive: true }
			);
			expect(fsPromises.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('12345'),
				expect.stringContaining('chatId: 12345'),
				'utf-8'
			);
		});

		it('should not overwrite existing chat file', async () => {
			// access succeeds = file exists
			await store.ensureChatFile('12345', 'Alice');

			expect(fsPromises.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('appendUserMessage', () => {
		it('should append formatted user message to chat file', async () => {
			await store.appendUserMessage('12345', 'Alice', 'Hello!');

			expect(fsPromises.appendFile).toHaveBeenCalledWith(
				expect.stringContaining('12345'),
				expect.stringContaining('**Alice**'),
				'utf-8'
			);
			expect(fsPromises.appendFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('Hello!'),
				'utf-8'
			);
		});
	});

	describe('appendBotReply', () => {
		it('should append bot reply to existing chat file', async () => {
			await store.appendBotReply('12345', 'Got it!');

			expect(fsPromises.appendFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('**Crewly**'),
				'utf-8'
			);
		});

		it('should skip silently if chat file does not exist', async () => {
			(fsPromises.access as jest.MockedFunction<typeof fsPromises.access>)
				.mockRejectedValueOnce(new Error('ENOENT'));

			await store.appendBotReply('99999', 'Should not write');

			expect(fsPromises.appendFile).not.toHaveBeenCalled();
		});
	});

	describe('getLatestThreadPath', () => {
		it('should return path when file exists', async () => {
			const result = await store.getLatestThreadPath('12345');
			expect(result).toContain('12345');
		});

		it('should return null when file does not exist', async () => {
			(fsPromises.access as jest.MockedFunction<typeof fsPromises.access>)
				.mockRejectedValueOnce(new Error('ENOENT'));

			const result = await store.getLatestThreadPath('99999');
			expect(result).toBeNull();
		});
	});

	describe('singleton management', () => {
		it('should start with null singleton', () => {
			expect(getTelegramThreadStore()).toBeNull();
		});

		it('should set and get singleton', () => {
			setTelegramThreadStore(store);
			expect(getTelegramThreadStore()).toBe(store);
		});

		it('should reset singleton', () => {
			setTelegramThreadStore(store);
			resetTelegramThreadStore();
			expect(getTelegramThreadStore()).toBeNull();
		});
	});
});
