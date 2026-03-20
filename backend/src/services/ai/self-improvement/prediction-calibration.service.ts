import * as fs from 'fs';
import * as path from 'path';

/**
 * A single prediction made by an agent.
 */
export interface Prediction {
	/** Unique prediction ID */
	id: string;
	/** What the agent predicted */
	prediction: string;
	/** Confidence level (0-1) */
	confidence: number;
	/** When the prediction was made (ISO date string) */
	madeAt: string;
	/** Actual outcome (set when resolved) */
	outcome?: string;
	/** Whether the prediction was accurate (set when resolved) */
	accurate?: boolean;
	/** When the prediction was resolved (ISO date string) */
	resolvedAt?: string;
}

/**
 * Persisted predictions data structure.
 */
export interface PredictionsData {
	/** All predictions (resolved and unresolved) */
	predictions: Prediction[];
	/** Overall calibration score (0-1, higher = better calibrated) */
	calibrationScore: number;
}

/**
 * Service for tracking agent prediction accuracy and calibration.
 *
 * Agents make predictions with confidence levels, then resolve them
 * with actual outcomes. The calibration score measures how well
 * an agent's confidence maps to actual accuracy.
 *
 * Storage: ~/.crewly/agents/{sessionName}/predictions.json
 */
export class PredictionCalibrationService {
	/**
	 * Get the file path for an agent's predictions.
	 *
	 * @param sessionName - Agent session name
	 * @returns Absolute path to predictions.json
	 */
	private getFilePath(sessionName: string): string {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		return path.join(homeDir, '.crewly', 'agents', sessionName, 'predictions.json');
	}

	/**
	 * Read predictions data from disk.
	 *
	 * @param sessionName - Agent session name
	 * @returns Predictions data, or empty default if file doesn't exist
	 */
	async getPredictions(sessionName: string): Promise<PredictionsData> {
		try {
			const filePath = this.getFilePath(sessionName);
			const raw = fs.readFileSync(filePath, 'utf-8');
			return JSON.parse(raw) as PredictionsData;
		} catch {
			return { predictions: [], calibrationScore: 0 };
		}
	}

	/**
	 * Record a new prediction.
	 *
	 * @param sessionName - Agent session name
	 * @param prediction - What is being predicted
	 * @param confidence - Confidence level (0-1)
	 * @returns The created prediction
	 */
	async makePrediction(
		sessionName: string,
		prediction: string,
		confidence: number
	): Promise<Prediction> {
		const data = await this.getPredictions(sessionName);
		const clampedConfidence = Math.max(0, Math.min(1, confidence));

		const newPrediction: Prediction = {
			id: `pred-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
			prediction,
			confidence: clampedConfidence,
			madeAt: new Date().toISOString().split('T')[0],
		};

		data.predictions.push(newPrediction);
		await this.save(sessionName, data);
		return newPrediction;
	}

	/**
	 * Resolve a prediction with its actual outcome.
	 *
	 * @param sessionName - Agent session name
	 * @param id - Prediction ID to resolve
	 * @param outcome - What actually happened
	 * @param accurate - Whether the prediction was accurate
	 * @returns The resolved prediction, or null if not found
	 */
	async resolvePrediction(
		sessionName: string,
		id: string,
		outcome: string,
		accurate: boolean
	): Promise<Prediction | null> {
		const data = await this.getPredictions(sessionName);
		const found = data.predictions.find((p) => p.id === id);

		if (!found) {
			return null;
		}

		found.outcome = outcome;
		found.accurate = accurate;
		found.resolvedAt = new Date().toISOString().split('T')[0];

		// Recalculate calibration score
		data.calibrationScore = this.calculateCalibrationScore(data.predictions);
		await this.save(sessionName, data);

		return found;
	}

	/**
	 * Get the agent's current calibration score.
	 *
	 * @param sessionName - Agent session name
	 * @returns Calibration score (0-1), or 0 if no resolved predictions
	 */
	async getCalibrationScore(sessionName: string): Promise<number> {
		const data = await this.getPredictions(sessionName);
		return data.calibrationScore;
	}

	/**
	 * Calculate calibration score from resolved predictions.
	 *
	 * Uses a simplified Brier-like score: for each resolved prediction,
	 * compares confidence to actual accuracy. Perfect calibration = 1.0.
	 *
	 * @param predictions - All predictions
	 * @returns Calibration score (0-1)
	 */
	private calculateCalibrationScore(predictions: Prediction[]): number {
		const resolved = predictions.filter((p) => p.resolvedAt !== undefined);
		if (resolved.length === 0) return 0;

		let totalError = 0;
		for (const p of resolved) {
			const actual = p.accurate ? 1 : 0;
			totalError += Math.pow(p.confidence - actual, 2);
		}

		// Brier score is mean squared error; invert so 1 = perfect
		const brierScore = totalError / resolved.length;
		return Math.round((1 - brierScore) * 100) / 100;
	}

	/**
	 * Persist predictions data to disk.
	 *
	 * @param sessionName - Agent session name
	 * @param data - Predictions data to save
	 */
	private async save(sessionName: string, data: PredictionsData): Promise<void> {
		const filePath = this.getFilePath(sessionName);
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
	}
}
