import * as fs from 'fs';
import * as path from 'path';

/**
 * Persisted attention management data structure.
 */
export interface AttentionData {
	/** Current focus items — topics the agent should prioritize */
	focus: string[];
	/** Suppressed items — topics the agent should deprioritize */
	suppressed: string[];
	/** Last time focus items were pruned (ISO date string) */
	lastPruned: string;
	/** Timestamps for each focus item (for pruning stale items) */
	focusTimestamps?: Record<string, string>;
}

/**
 * Number of days after which a focus item is considered stale.
 */
const PRUNE_THRESHOLD_DAYS = 14;

/**
 * Service for managing agent attention — what to focus on and what to suppress.
 *
 * Focus items direct the agent's attention toward high-priority topics.
 * Suppressed items filter out noise from irrelevant past context.
 * Pruning removes stale focus items that haven't been updated in 2+ weeks.
 *
 * Storage: ~/.crewly/agents/{sessionName}/attention.json
 */
export class AttentionService {
	/**
	 * Get the file path for an agent's attention data.
	 *
	 * @param sessionName - Agent session name
	 * @returns Absolute path to attention.json
	 */
	private getFilePath(sessionName: string): string {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		return path.join(homeDir, '.crewly', 'agents', sessionName, 'attention.json');
	}

	/**
	 * Read attention data from disk.
	 *
	 * @param sessionName - Agent session name
	 * @returns Attention data, or empty default if file doesn't exist
	 */
	async getAttention(sessionName: string): Promise<AttentionData> {
		try {
			const filePath = this.getFilePath(sessionName);
			const raw = fs.readFileSync(filePath, 'utf-8');
			return JSON.parse(raw) as AttentionData;
		} catch {
			return { focus: [], suppressed: [], lastPruned: '', focusTimestamps: {} };
		}
	}

	/**
	 * Get the current focus items for an agent.
	 *
	 * @param sessionName - Agent session name
	 * @returns Array of focus item strings
	 */
	async getFocus(sessionName: string): Promise<string[]> {
		const data = await this.getAttention(sessionName);
		return data.focus;
	}

	/**
	 * Set the focus items for an agent (replaces existing focus).
	 *
	 * @param sessionName - Agent session name
	 * @param items - New focus items
	 */
	async setFocus(sessionName: string, items: string[]): Promise<void> {
		const data = await this.getAttention(sessionName);
		const now = new Date().toISOString().split('T')[0];

		data.focus = items;
		data.focusTimestamps = {};
		for (const item of items) {
			data.focusTimestamps[item] = now;
		}

		await this.save(sessionName, data);
	}

	/**
	 * Add a single item to the suppressed list.
	 *
	 * @param sessionName - Agent session name
	 * @param item - Item to suppress
	 */
	async suppress(sessionName: string, item: string): Promise<void> {
		const data = await this.getAttention(sessionName);

		if (!data.suppressed.includes(item)) {
			data.suppressed.push(item);
		}

		// Also remove from focus if present
		data.focus = data.focus.filter((f) => f !== item);
		if (data.focusTimestamps) {
			delete data.focusTimestamps[item];
		}

		await this.save(sessionName, data);
	}

	/**
	 * Prune stale focus items that haven't been updated in PRUNE_THRESHOLD_DAYS.
	 *
	 * @param sessionName - Agent session name
	 * @returns Number of items pruned
	 */
	async prune(sessionName: string): Promise<number> {
		const data = await this.getAttention(sessionName);
		const now = new Date();
		const timestamps = data.focusTimestamps || {};
		let pruned = 0;

		data.focus = data.focus.filter((item) => {
			const ts = timestamps[item];
			if (!ts) {
				// No timestamp — prune it
				pruned++;
				return false;
			}

			const itemDate = new Date(ts);
			const daysDiff = (now.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24);

			if (daysDiff > PRUNE_THRESHOLD_DAYS) {
				pruned++;
				delete timestamps[item];
				return false;
			}
			return true;
		});

		data.focusTimestamps = timestamps;
		data.lastPruned = now.toISOString().split('T')[0];
		await this.save(sessionName, data);

		return pruned;
	}

	/**
	 * Persist attention data to disk.
	 *
	 * @param sessionName - Agent session name
	 * @param data - Attention data to save
	 */
	private async save(sessionName: string, data: AttentionData): Promise<void> {
		const filePath = this.getFilePath(sessionName);
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
	}
}
