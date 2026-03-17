import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../utils/file-io.utils.js', () => ({
	atomicWriteJson: jest.fn<(path: string, data: unknown) => Promise<void>>().mockResolvedValue(undefined),
	safeReadJson: jest.fn<(path: string, defaultVal: unknown, logger?: unknown) => Promise<unknown>>().mockResolvedValue(null),
}));

jest.mock('fs/promises', () => ({
	chmod: jest.fn<(path: string, mode: number) => Promise<void>>().mockResolvedValue(undefined),
	unlink: jest.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
	access: jest.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				debug: jest.fn(),
			}),
		}),
	},
}));

import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import * as fsPromises from 'fs/promises';
import {
	saveTelegramCredentials,
	loadTelegramCredentials,
	deleteTelegramCredentials,
	hasSavedTelegramCredentials,
} from './telegram-credentials.service.js';

describe('TelegramCredentialsService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('saveTelegramCredentials', () => {
		it('should save credentials via atomicWriteJson', async () => {
			await saveTelegramCredentials({
				botToken: 'test-token-123',
				defaultChatId: '12345',
				allowedUserIds: ['111', '222'],
			});

			expect(atomicWriteJson).toHaveBeenCalledWith(
				expect.stringContaining('telegram-credentials.json'),
				{
					botToken: 'test-token-123',
					defaultChatId: '12345',
					allowedUserIds: ['111', '222'],
				}
			);
		});

		it('should set file permissions to 0600', async () => {
			await saveTelegramCredentials({ botToken: 'token' });

			expect(fsPromises.chmod).toHaveBeenCalledWith(
				expect.stringContaining('telegram-credentials.json'),
				0o600
			);
		});

		it('should not throw when chmod fails', async () => {
			(fsPromises.chmod as jest.MockedFunction<typeof fsPromises.chmod>)
				.mockRejectedValueOnce(new Error('Permission denied'));

			await expect(saveTelegramCredentials({ botToken: 'token' })).resolves.not.toThrow();
		});
	});

	describe('loadTelegramCredentials', () => {
		it('should return config when credentials exist', async () => {
			(safeReadJson as jest.MockedFunction<typeof safeReadJson>).mockResolvedValueOnce({
				botToken: 'saved-token',
				defaultChatId: '999',
				allowedUserIds: ['333'],
			});

			const result = await loadTelegramCredentials();

			expect(result).toEqual({
				botToken: 'saved-token',
				defaultChatId: '999',
				allowedUserIds: ['333'],
			});
		});

		it('should return null when no credentials exist', async () => {
			(safeReadJson as jest.MockedFunction<typeof safeReadJson>).mockResolvedValueOnce(null);

			const result = await loadTelegramCredentials();
			expect(result).toBeNull();
		});

		it('should return null when botToken is missing', async () => {
			(safeReadJson as jest.MockedFunction<typeof safeReadJson>).mockResolvedValueOnce({
				defaultChatId: '999',
			});

			const result = await loadTelegramCredentials();
			expect(result).toBeNull();
		});
	});

	describe('deleteTelegramCredentials', () => {
		it('should unlink the credentials file', async () => {
			await deleteTelegramCredentials();

			expect(fsPromises.unlink).toHaveBeenCalledWith(
				expect.stringContaining('telegram-credentials.json')
			);
		});

		it('should not throw when file does not exist', async () => {
			const error = new Error('Not found') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			(fsPromises.unlink as jest.MockedFunction<typeof fsPromises.unlink>)
				.mockRejectedValueOnce(error);

			await expect(deleteTelegramCredentials()).resolves.not.toThrow();
		});
	});

	describe('hasSavedTelegramCredentials', () => {
		it('should return true when file exists', async () => {
			const result = await hasSavedTelegramCredentials();
			expect(result).toBe(true);
		});

		it('should return false when file does not exist', async () => {
			(fsPromises.access as jest.MockedFunction<typeof fsPromises.access>)
				.mockRejectedValueOnce(new Error('ENOENT'));

			const result = await hasSavedTelegramCredentials();
			expect(result).toBe(false);
		});
	});
});
