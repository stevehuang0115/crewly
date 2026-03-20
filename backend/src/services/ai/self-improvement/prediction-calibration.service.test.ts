import * as fs from 'fs';
import { PredictionCalibrationService } from './prediction-calibration.service.js';

jest.mock('fs');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('PredictionCalibrationService', () => {
	let service: PredictionCalibrationService;
	const sessionName = 'crewly-product-sam-test';

	beforeEach(() => {
		service = new PredictionCalibrationService();
		jest.resetAllMocks();
		mockedFs.mkdirSync.mockReturnValue(undefined);
		mockedFs.writeFileSync.mockReturnValue(undefined);
	});

	describe('getPredictions', () => {
		it('should return empty default when file does not exist', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.getPredictions(sessionName);

			expect(result.predictions).toEqual([]);
			expect(result.calibrationScore).toBe(0);
		});

		it('should return persisted data when file exists', async () => {
			const data = {
				predictions: [{ id: 'pred-1', prediction: 'takes 2 sessions', confidence: 0.7, madeAt: '2026-03-19' }],
				calibrationScore: 0.65,
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const result = await service.getPredictions(sessionName);

			expect(result.predictions).toHaveLength(1);
			expect(result.calibrationScore).toBe(0.65);
		});
	});

	describe('makePrediction', () => {
		it('should create a new prediction with clamped confidence', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const pred = await service.makePrediction(sessionName, 'refactor takes 2 sessions', 0.8);

			expect(pred.prediction).toBe('refactor takes 2 sessions');
			expect(pred.confidence).toBe(0.8);
			expect(pred.id).toMatch(/^pred-/);
			expect(pred.madeAt).toBeTruthy();
			expect(pred.outcome).toBeUndefined();
		});

		it('should clamp confidence to 0-1 range', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const pred = await service.makePrediction(sessionName, 'test', 1.5);
			expect(pred.confidence).toBe(1);

			const pred2 = await service.makePrediction(sessionName, 'test2', -0.5);
			expect(pred2.confidence).toBe(0);
		});
	});

	describe('resolvePrediction', () => {
		it('should resolve an existing prediction', async () => {
			const data = {
				predictions: [{ id: 'pred-123', prediction: 'takes 2 sessions', confidence: 0.7, madeAt: '2026-03-19' }],
				calibrationScore: 0,
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const resolved = await service.resolvePrediction(sessionName, 'pred-123', 'took 1 session', true);

			expect(resolved).not.toBeNull();
			expect(resolved!.outcome).toBe('took 1 session');
			expect(resolved!.accurate).toBe(true);
			expect(resolved!.resolvedAt).toBeTruthy();
		});

		it('should return null for non-existent prediction', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.resolvePrediction(sessionName, 'pred-999', 'outcome', true);

			expect(result).toBeNull();
		});

		it('should update calibration score on resolve', async () => {
			const data = {
				predictions: [
					{ id: 'pred-1', prediction: 'p1', confidence: 0.9, madeAt: '2026-03-19' },
				],
				calibrationScore: 0,
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			await service.resolvePrediction(sessionName, 'pred-1', 'correct', true);

			// Check that writeFileSync was called with updated calibration
			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.calibrationScore).toBeGreaterThan(0);
		});
	});

	describe('getCalibrationScore', () => {
		it('should return 0 when no predictions exist', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const score = await service.getCalibrationScore(sessionName);

			expect(score).toBe(0);
		});

		it('should return stored calibration score', async () => {
			const data = { predictions: [], calibrationScore: 0.72 };
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const score = await service.getCalibrationScore(sessionName);

			expect(score).toBe(0.72);
		});
	});

	describe('calibration calculation', () => {
		it('should give high score for well-calibrated predictions', async () => {
			// High confidence + accurate = good calibration
			const data = {
				predictions: [
					{ id: 'p1', prediction: 'p1', confidence: 0.9, madeAt: '2026-03-19', outcome: 'yes', accurate: true, resolvedAt: '2026-03-19' },
					{ id: 'p2', prediction: 'p2', confidence: 0.1, madeAt: '2026-03-19', outcome: 'no', accurate: false, resolvedAt: '2026-03-19' },
				],
				calibrationScore: 0,
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			// Resolve a new one to trigger recalculation
			const newData = { ...data, predictions: [...data.predictions, { id: 'p3', prediction: 'p3', confidence: 0.8, madeAt: '2026-03-19' }] };
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(newData));

			await service.resolvePrediction(sessionName, 'p3', 'correct', true);

			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			// All well-calibrated: 0.9→true, 0.1→false, 0.8→true
			expect(saved.calibrationScore).toBeGreaterThan(0.9);
		});
	});
});
