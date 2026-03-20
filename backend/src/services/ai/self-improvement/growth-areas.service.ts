import * as fs from 'fs';
import * as path from 'path';

/**
 * A single growth area tracked for an agent.
 */
export interface GrowthArea {
	/** Description of the growth area */
	area: string;
	/** Date the area was identified (ISO date string) */
	identifiedAt: string;
	/** Current progress status */
	progress: 'identified' | 'improving' | 'proficient';
	/** Evidence of progress or regression */
	evidence: string[];
}

/**
 * Persisted growth areas data structure.
 */
export interface GrowthAreasData {
	/** List of tracked growth areas */
	areas: GrowthArea[];
	/** Last time the areas were reviewed (ISO date string) */
	lastReviewedAt: string;
}

/**
 * Keywords that indicate potential growth areas when found in learnings/failures.
 */
const GROWTH_KEYWORDS: Record<string, string> = {
	'error handling': 'error handling patterns',
	'async': 'async/await best practices',
	'test': 'test coverage and quality',
	'type': 'TypeScript type system',
	'performance': 'performance optimization',
	'security': 'security awareness',
	'edge case': 'edge case handling',
	'timeout': 'timeout and retry patterns',
	'memory leak': 'memory management',
	'race condition': 'concurrency handling',
};

/**
 * Service for tracking agent growth areas over time.
 *
 * Each agent maintains a growth-areas.json file that records areas
 * where the agent is actively improving. Growth areas can be manually
 * added or auto-extracted from learnings and failures.
 *
 * Storage: ~/.crewly/agents/{sessionName}/growth-areas.json
 */
export class GrowthAreasService {
	/**
	 * Get the file path for an agent's growth areas.
	 *
	 * @param sessionName - Agent session name
	 * @returns Absolute path to growth-areas.json
	 */
	private getFilePath(sessionName: string): string {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		return path.join(homeDir, '.crewly', 'agents', sessionName, 'growth-areas.json');
	}

	/**
	 * Read growth areas data from disk.
	 *
	 * @param sessionName - Agent session name
	 * @returns Growth areas data, or empty default if file doesn't exist
	 */
	async getGrowthAreas(sessionName: string): Promise<GrowthAreasData> {
		try {
			const filePath = this.getFilePath(sessionName);
			const raw = fs.readFileSync(filePath, 'utf-8');
			return JSON.parse(raw) as GrowthAreasData;
		} catch {
			return { areas: [], lastReviewedAt: '' };
		}
	}

	/**
	 * Add a new growth area for an agent.
	 *
	 * @param sessionName - Agent session name
	 * @param area - Description of the growth area
	 * @returns The created growth area
	 */
	async addGrowthArea(sessionName: string, area: string): Promise<GrowthArea> {
		const data = await this.getGrowthAreas(sessionName);

		// Don't add duplicates
		const existing = data.areas.find(
			(a) => a.area.toLowerCase() === area.toLowerCase()
		);
		if (existing) {
			return existing;
		}

		const newArea: GrowthArea = {
			area,
			identifiedAt: new Date().toISOString().split('T')[0],
			progress: 'identified',
			evidence: [],
		};

		data.areas.push(newArea);
		data.lastReviewedAt = new Date().toISOString().split('T')[0];
		await this.save(sessionName, data);

		return newArea;
	}

	/**
	 * Update the progress of an existing growth area.
	 *
	 * @param sessionName - Agent session name
	 * @param area - Growth area description to update
	 * @param progress - New progress status
	 * @param evidence - Evidence supporting the progress update
	 * @returns Updated growth area or null if not found
	 */
	async updateProgress(
		sessionName: string,
		area: string,
		progress: 'identified' | 'improving' | 'proficient',
		evidence: string
	): Promise<GrowthArea | null> {
		const data = await this.getGrowthAreas(sessionName);
		const found = data.areas.find(
			(a) => a.area.toLowerCase() === area.toLowerCase()
		);

		if (!found) {
			return null;
		}

		found.progress = progress;
		found.evidence.push(evidence);
		data.lastReviewedAt = new Date().toISOString().split('T')[0];
		await this.save(sessionName, data);

		return found;
	}

	/**
	 * Auto-extract potential growth areas from a learning or failure text.
	 *
	 * @param sessionName - Agent session name
	 * @param text - Learning or failure text to analyze
	 * @returns Array of newly added growth areas (empty if no new areas found)
	 */
	async extractFromText(sessionName: string, text: string): Promise<GrowthArea[]> {
		const lowerText = text.toLowerCase();
		const added: GrowthArea[] = [];

		for (const [keyword, areaName] of Object.entries(GROWTH_KEYWORDS)) {
			if (lowerText.includes(keyword)) {
				const data = await this.getGrowthAreas(sessionName);
				const exists = data.areas.some(
					(a) => a.area.toLowerCase() === areaName.toLowerCase()
				);
				if (!exists) {
					const newArea = await this.addGrowthArea(sessionName, areaName);
					added.push(newArea);
				}
			}
		}

		return added;
	}

	/**
	 * Persist growth areas data to disk.
	 *
	 * @param sessionName - Agent session name
	 * @param data - Growth areas data to save
	 */
	private async save(sessionName: string, data: GrowthAreasData): Promise<void> {
		const filePath = this.getFilePath(sessionName);
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
	}
}
