import { vi, describe, it, expect, beforeEach, type MockedFunction } from 'vitest';
import * as fs from 'fs';
import { MemoryConsolidationService, MemoryProvider } from './memory-consolidation.service.js';

vi.mock('fs');

const mockedFs = fs as unknown as vi.Mocked<typeof fs>;

describe('MemoryConsolidationService', () => {
	let service: MemoryConsolidationService;
	let mockProvider: MockedFunction<MemoryProvider>;
	const sessionName = 'crewly-product-sam-test';

	beforeEach(() => {
		vi.resetAllMocks();
		mockedFs.mkdirSync.mockReturnValue(undefined);
		mockedFs.writeFileSync.mockReturnValue(undefined);
		mockProvider = vi.fn();
		service = new MemoryConsolidationService(mockProvider);
	});

	describe('getReport', () => {
		it('should return empty default when file does not exist', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.getReport(sessionName);

			expect(result.patterns).toEqual([]);
			expect(result.insights).toEqual([]);
			expect(result.memoriesAnalyzed).toBe(0);
		});

		it('should return persisted report when file exists', async () => {
			const report = {
				patterns: [{ pattern: 'testing', occurrences: 5, sources: ['learning'], identifiedAt: '2026-03-19' }],
				insights: [],
				consolidatedAt: '2026-03-19T10:00:00Z',
				memoriesAnalyzed: 10,
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(report));

			const result = await service.getReport(sessionName);

			expect(result.patterns).toHaveLength(1);
			expect(result.memoriesAnalyzed).toBe(10);
		});
	});

	describe('consolidate', () => {
		it('should return empty report when no memories exist', async () => {
			mockProvider.mockResolvedValue([]);

			const report = await service.consolidate(sessionName);

			expect(report.patterns).toEqual([]);
			expect(report.insights).toEqual([]);
			expect(report.memoriesAnalyzed).toBe(0);
			expect(mockedFs.writeFileSync).toHaveBeenCalled();
		});

		it('should identify patterns from recurring topics', async () => {
			mockProvider.mockResolvedValue([
				'Fixed error in exception handling with catch and throw patterns, added test coverage with jest assert',
				'Found another error in catch block exception, wrote more tests to mock edge cases and assert',
				'Improved test coverage with jest mock for the auth module, caught an error in exception handling',
			]);

			const report = await service.consolidate(sessionName);

			expect(report.memoriesAnalyzed).toBe(3);
			expect(report.patterns.length).toBeGreaterThan(0);

			const patternNames = report.patterns.map((p) => p.pattern);
			// Both 'error handling' and 'testing' should appear (2+ keywords each in 2+ memories)
			expect(patternNames).toContain('error handling');
			expect(patternNames).toContain('testing');
		});

		it('should sort patterns by occurrence count', async () => {
			mockProvider.mockResolvedValue([
				'error handling test coverage improvement',
				'error handling exception test mock assert',
				'error handling catch throw failure test jest',
				'performance test optimization slow cache test',
			]);

			const report = await service.consolidate(sessionName);

			if (report.patterns.length >= 2) {
				expect(report.patterns[0].occurrences).toBeGreaterThanOrEqual(report.patterns[1].occurrences);
			}
		});

		it('should derive insights when pattern appears in both failures and successes', async () => {
			mockProvider.mockResolvedValue([
				'failure: missed exception in auth module with catch throw',
				'completed: improved exception handling with better catch and throw patterns',
				'another bug: exception in catch throw validation code',
			]);

			const report = await service.consolidate(sessionName);

			const learningInsights = report.insights.filter((i) =>
				i.insight.includes('active learning area')
			);
			expect(learningInsights.length).toBeGreaterThan(0);
		});

		it('should persist report to disk', async () => {
			mockProvider.mockResolvedValue(['test memory']);

			await service.consolidate(sessionName);

			expect(mockedFs.writeFileSync).toHaveBeenCalled();
			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.consolidatedAt).toBeTruthy();
		});
	});
});
