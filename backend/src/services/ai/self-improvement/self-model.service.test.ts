import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import { SelfModelService } from './self-model.service.js';

vi.mock('fs');

const mockedFs = fs as unknown as vi.Mocked<typeof fs>;

describe('SelfModelService', () => {
	let service: SelfModelService;
	const sessionName = 'crewly-product-sam-test';

	beforeEach(() => {
		service = new SelfModelService();
		vi.resetAllMocks();
		mockedFs.mkdirSync.mockReturnValue(undefined);
		mockedFs.writeFileSync.mockReturnValue(undefined);
	});

	describe('getSelfModel', () => {
		it('should return empty default when file does not exist', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.getSelfModel(sessionName);

			expect(result.decisionPatterns).toEqual([]);
			expect(result.biases).toEqual([]);
			expect(result.blindSpots).toEqual([]);
		});

		it('should return persisted data when file exists', async () => {
			const data = {
				decisionPatterns: [{ pattern: 'over-engineers', frequency: 3, lastSeen: '2026-03-19' }],
				biases: [{ bias: 'prefers TS over bash', severity: 'low' }],
				blindSpots: [{ description: 'misses edge cases', identifiedAt: '2026-03-19' }],
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const result = await service.getSelfModel(sessionName);

			expect(result.decisionPatterns).toHaveLength(1);
			expect(result.biases).toHaveLength(1);
			expect(result.blindSpots).toHaveLength(1);
		});
	});

	describe('addPattern', () => {
		it('should add a new decision pattern', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const pattern = await service.addPattern(sessionName, 'tends to over-engineer');

			expect(pattern.pattern).toBe('tends to over-engineer');
			expect(pattern.frequency).toBe(1);
			expect(mockedFs.writeFileSync).toHaveBeenCalled();
		});

		it('should increment frequency for existing pattern', async () => {
			const existing = {
				decisionPatterns: [{ pattern: 'tends to over-engineer', frequency: 2, lastSeen: '2026-03-18' }],
				biases: [],
				blindSpots: [],
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

			const pattern = await service.addPattern(sessionName, 'Tends to over-engineer');

			expect(pattern.frequency).toBe(3);
		});
	});

	describe('addBias', () => {
		it('should add a new bias', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const bias = await service.addBias(sessionName, 'prefers TS over bash', 'medium');

			expect(bias.bias).toBe('prefers TS over bash');
			expect(bias.severity).toBe('medium');
		});

		it('should update severity for existing bias', async () => {
			const existing = {
				decisionPatterns: [],
				biases: [{ bias: 'prefers TS over bash', severity: 'low' }],
				blindSpots: [],
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

			const bias = await service.addBias(sessionName, 'Prefers TS over bash', 'high');

			expect(bias.severity).toBe('high');
		});

		it('should default severity to low', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const bias = await service.addBias(sessionName, 'some bias');

			expect(bias.severity).toBe('low');
		});
	});

	describe('addBlindSpot', () => {
		it('should add a new blind spot', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const spot = await service.addBlindSpot(sessionName, 'misses error handling edge cases');

			expect(spot.description).toBe('misses error handling edge cases');
			expect(spot.identifiedAt).toBeTruthy();
		});

		it('should not add duplicate blind spots', async () => {
			const existing = {
				decisionPatterns: [],
				biases: [],
				blindSpots: [{ description: 'misses edge cases', identifiedAt: '2026-03-19' }],
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

			const spot = await service.addBlindSpot(sessionName, 'Misses edge cases');

			expect(spot.description).toBe('misses edge cases');
			expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
		});
	});
});
