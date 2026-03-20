import * as fs from 'fs';
import * as path from 'path';

/**
 * A recognized decision pattern for an agent.
 */
export interface DecisionPattern {
	/** Description of the pattern */
	pattern: string;
	/** How many times this pattern has been observed */
	frequency: number;
	/** Last time this pattern was observed (ISO date string) */
	lastSeen: string;
}

/**
 * A recognized cognitive bias for an agent.
 */
export interface CognitiveBias {
	/** Description of the bias */
	bias: string;
	/** How impactful this bias is */
	severity: 'low' | 'medium' | 'high';
}

/**
 * A recognized blind spot for an agent.
 */
export interface BlindSpot {
	/** Description of the blind spot */
	description: string;
	/** When this blind spot was identified (ISO date string) */
	identifiedAt: string;
}

/**
 * Persisted self-model data structure.
 */
export interface SelfModelData {
	/** Recurring decision patterns */
	decisionPatterns: DecisionPattern[];
	/** Identified cognitive biases */
	biases: CognitiveBias[];
	/** Known blind spots */
	blindSpots: BlindSpot[];
}

/**
 * Service for managing an agent's self-model — their understanding
 * of their own decision patterns, biases, and blind spots.
 *
 * Storage: ~/.crewly/agents/{sessionName}/self-model.json
 */
export class SelfModelService {
	/**
	 * Get the file path for an agent's self-model.
	 *
	 * @param sessionName - Agent session name
	 * @returns Absolute path to self-model.json
	 */
	private getFilePath(sessionName: string): string {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		return path.join(homeDir, '.crewly', 'agents', sessionName, 'self-model.json');
	}

	/**
	 * Read the self-model data from disk.
	 *
	 * @param sessionName - Agent session name
	 * @returns Self-model data, or empty default if file doesn't exist
	 */
	async getSelfModel(sessionName: string): Promise<SelfModelData> {
		try {
			const filePath = this.getFilePath(sessionName);
			const raw = fs.readFileSync(filePath, 'utf-8');
			return JSON.parse(raw) as SelfModelData;
		} catch {
			return { decisionPatterns: [], biases: [], blindSpots: [] };
		}
	}

	/**
	 * Add or increment a decision pattern.
	 *
	 * @param sessionName - Agent session name
	 * @param pattern - Description of the decision pattern
	 * @returns The added or updated pattern
	 */
	async addPattern(sessionName: string, pattern: string): Promise<DecisionPattern> {
		const data = await this.getSelfModel(sessionName);
		const existing = data.decisionPatterns.find(
			(p) => p.pattern.toLowerCase() === pattern.toLowerCase()
		);

		if (existing) {
			existing.frequency++;
			existing.lastSeen = new Date().toISOString().split('T')[0];
			await this.save(sessionName, data);
			return existing;
		}

		const newPattern: DecisionPattern = {
			pattern,
			frequency: 1,
			lastSeen: new Date().toISOString().split('T')[0],
		};
		data.decisionPatterns.push(newPattern);
		await this.save(sessionName, data);
		return newPattern;
	}

	/**
	 * Add a cognitive bias.
	 *
	 * @param sessionName - Agent session name
	 * @param bias - Description of the bias
	 * @param severity - How impactful the bias is
	 * @returns The added bias
	 */
	async addBias(
		sessionName: string,
		bias: string,
		severity: 'low' | 'medium' | 'high' = 'low'
	): Promise<CognitiveBias> {
		const data = await this.getSelfModel(sessionName);
		const existing = data.biases.find(
			(b) => b.bias.toLowerCase() === bias.toLowerCase()
		);

		if (existing) {
			existing.severity = severity;
			await this.save(sessionName, data);
			return existing;
		}

		const newBias: CognitiveBias = { bias, severity };
		data.biases.push(newBias);
		await this.save(sessionName, data);
		return newBias;
	}

	/**
	 * Add a blind spot.
	 *
	 * @param sessionName - Agent session name
	 * @param description - Description of the blind spot
	 * @returns The added blind spot
	 */
	async addBlindSpot(sessionName: string, description: string): Promise<BlindSpot> {
		const data = await this.getSelfModel(sessionName);
		const existing = data.blindSpots.find(
			(b) => b.description.toLowerCase() === description.toLowerCase()
		);

		if (existing) {
			return existing;
		}

		const newSpot: BlindSpot = {
			description,
			identifiedAt: new Date().toISOString().split('T')[0],
		};
		data.blindSpots.push(newSpot);
		await this.save(sessionName, data);
		return newSpot;
	}

	/**
	 * Persist self-model data to disk.
	 *
	 * @param sessionName - Agent session name
	 * @param data - Self-model data to save
	 */
	private async save(sessionName: string, data: SelfModelData): Promise<void> {
		const filePath = this.getFilePath(sessionName);
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
	}
}
