import * as fs from 'fs';
import { GrowthAreasService } from './growth-areas.service.js';

jest.mock('fs');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('GrowthAreasService', () => {
	let service: GrowthAreasService;
	const sessionName = 'crewly-product-sam-test';

	beforeEach(() => {
		service = new GrowthAreasService();
		jest.resetAllMocks();
		mockedFs.mkdirSync.mockReturnValue(undefined);
		mockedFs.writeFileSync.mockReturnValue(undefined);
	});

	describe('getGrowthAreas', () => {
		it('should return empty default when file does not exist', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.getGrowthAreas(sessionName);

			expect(result.areas).toEqual([]);
			expect(result.lastReviewedAt).toBe('');
		});

		it('should return persisted data when file exists', async () => {
			const data = {
				areas: [{ area: 'testing', identifiedAt: '2026-03-19', progress: 'improving', evidence: ['wrote 50 tests'] }],
				lastReviewedAt: '2026-03-19',
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const result = await service.getGrowthAreas(sessionName);

			expect(result.areas).toHaveLength(1);
			expect(result.areas[0].area).toBe('testing');
		});
	});

	describe('addGrowthArea', () => {
		it('should add a new growth area', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const area = await service.addGrowthArea(sessionName, 'error handling');

			expect(area.area).toBe('error handling');
			expect(area.progress).toBe('identified');
			expect(area.evidence).toEqual([]);
			expect(mockedFs.writeFileSync).toHaveBeenCalled();
		});

		it('should not add duplicate growth areas', async () => {
			const existing = {
				areas: [{ area: 'error handling', identifiedAt: '2026-03-19', progress: 'identified', evidence: [] }],
				lastReviewedAt: '2026-03-19',
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

			const area = await service.addGrowthArea(sessionName, 'Error Handling');

			expect(area.area).toBe('error handling');
			// writeFileSync should NOT be called for duplicate
			expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
		});
	});

	describe('updateProgress', () => {
		it('should update progress and add evidence', async () => {
			const existing = {
				areas: [{ area: 'testing', identifiedAt: '2026-03-19', progress: 'identified', evidence: [] }],
				lastReviewedAt: '2026-03-19',
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

			const result = await service.updateProgress(sessionName, 'testing', 'improving', 'wrote 20 tests');

			expect(result).not.toBeNull();
			expect(result!.progress).toBe('improving');
			expect(result!.evidence).toContain('wrote 20 tests');
		});

		it('should return null for non-existent area', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.updateProgress(sessionName, 'nonexistent', 'improving', 'evidence');

			expect(result).toBeNull();
		});
	});

	describe('extractFromText', () => {
		it('should extract growth areas from text with matching keywords', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const areas = await service.extractFromText(
				sessionName,
				'Fixed error handling in async code but still struggling with edge cases'
			);

			expect(areas.length).toBeGreaterThan(0);
			const areaNames = areas.map((a) => a.area);
			expect(areaNames).toContain('error handling patterns');
		});

		it('should return empty array when no keywords match', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const areas = await service.extractFromText(sessionName, 'normal work day nothing special');

			expect(areas).toEqual([]);
		});

		it('should not add areas that already exist', async () => {
			const existing = {
				areas: [
					{ area: 'error handling patterns', identifiedAt: '2026-03-19', progress: 'identified', evidence: [] },
					{ area: 'async/await best practices', identifiedAt: '2026-03-19', progress: 'identified', evidence: [] },
				],
				lastReviewedAt: '2026-03-19',
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

			const areas = await service.extractFromText(sessionName, 'error handling in async code');

			expect(areas).toEqual([]);
		});
	});
});
