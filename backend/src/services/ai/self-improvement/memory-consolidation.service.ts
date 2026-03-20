import * as fs from 'fs';
import * as path from 'path';

/**
 * A pattern identified across multiple memories.
 */
export interface ConsolidatedPattern {
	/** Description of the pattern */
	pattern: string;
	/** How many memories support this pattern */
	occurrences: number;
	/** Source categories (e.g., 'learning', 'failure', 'success') */
	sources: string[];
	/** When this pattern was identified (ISO date string) */
	identifiedAt: string;
}

/**
 * An insight derived from cross-memory analysis.
 */
export interface ConsolidatedInsight {
	/** The insight text */
	insight: string;
	/** Confidence level */
	confidence: 'low' | 'medium' | 'high';
	/** Related memory snippets that support this insight */
	relatedMemories: string[];
}

/**
 * Persisted consolidation report structure.
 */
export interface ConsolidationReport {
	/** Patterns identified across memories */
	patterns: ConsolidatedPattern[];
	/** Insights derived from analysis */
	insights: ConsolidatedInsight[];
	/** When this consolidation was run (ISO string) */
	consolidatedAt: string;
	/** Number of memories analyzed */
	memoriesAnalyzed: number;
}

/**
 * Provider function type for retrieving agent memories.
 * Allows dependency injection for testing.
 */
export type MemoryProvider = (sessionName: string) => Promise<string[]>;

/**
 * Service for cross-layer memory consolidation.
 *
 * Reads all agent memories (learnings, failures, successes), identifies
 * recurring patterns, and generates a consolidation report. Can be run
 * periodically (e.g., weekly) to keep insights fresh.
 *
 * Storage: ~/.crewly/agents/{sessionName}/consolidation.json
 */
export class MemoryConsolidationService {
	private memoryProvider: MemoryProvider;

	/**
	 * Create a new MemoryConsolidationService.
	 *
	 * @param memoryProvider - Function that retrieves agent memories
	 */
	constructor(memoryProvider: MemoryProvider) {
		this.memoryProvider = memoryProvider;
	}

	/**
	 * Get the file path for an agent's consolidation report.
	 *
	 * @param sessionName - Agent session name
	 * @returns Absolute path to consolidation.json
	 */
	private getFilePath(sessionName: string): string {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		return path.join(homeDir, '.crewly', 'agents', sessionName, 'consolidation.json');
	}

	/**
	 * Read the most recent consolidation report from disk.
	 *
	 * @param sessionName - Agent session name
	 * @returns Consolidation report, or empty default if none exists
	 */
	async getReport(sessionName: string): Promise<ConsolidationReport> {
		try {
			const filePath = this.getFilePath(sessionName);
			const raw = fs.readFileSync(filePath, 'utf-8');
			return JSON.parse(raw) as ConsolidationReport;
		} catch {
			return {
				patterns: [],
				insights: [],
				consolidatedAt: '',
				memoriesAnalyzed: 0,
			};
		}
	}

	/**
	 * Run consolidation analysis on all agent memories.
	 *
	 * Identifies recurring patterns by counting word/phrase frequency
	 * across memories and extracting common themes.
	 *
	 * @param sessionName - Agent session name
	 * @returns The generated consolidation report
	 */
	async consolidate(sessionName: string): Promise<ConsolidationReport> {
		const memories = await this.memoryProvider(sessionName);

		if (memories.length === 0) {
			const emptyReport: ConsolidationReport = {
				patterns: [],
				insights: [],
				consolidatedAt: new Date().toISOString(),
				memoriesAnalyzed: 0,
			};
			await this.save(sessionName, emptyReport);
			return emptyReport;
		}

		const patterns = this.extractPatterns(memories);
		const insights = this.deriveInsights(memories, patterns);

		const report: ConsolidationReport = {
			patterns,
			insights,
			consolidatedAt: new Date().toISOString(),
			memoriesAnalyzed: memories.length,
		};

		await this.save(sessionName, report);
		return report;
	}

	/**
	 * Extract recurring patterns from memories by analyzing keyword frequency.
	 *
	 * @param memories - Array of memory text strings
	 * @returns Identified patterns sorted by occurrence count
	 */
	private extractPatterns(memories: string[]): ConsolidatedPattern[] {
		const keyPhrases: Record<string, { count: number; sources: Set<string> }> = {};
		const now = new Date().toISOString().split('T')[0];

		// Track keyword groups
		const topicKeywords: Record<string, string[]> = {
			'error handling': ['error', 'exception', 'catch', 'throw', 'failure'],
			'testing': ['test', 'coverage', 'jest', 'assert', 'mock'],
			'performance': ['performance', 'slow', 'optimize', 'cache', 'latency'],
			'async patterns': ['async', 'await', 'promise', 'concurrent', 'race'],
			'type safety': ['type', 'typescript', 'interface', 'generic', 'cast'],
			'code quality': ['refactor', 'clean', 'duplicate', 'pattern', 'convention'],
			'deployment': ['deploy', 'docker', 'build', 'release', 'production'],
			'security': ['security', 'auth', 'token', 'credential', 'vulnerability'],
		};

		for (const memory of memories) {
			const lower = memory.toLowerCase();
			for (const [topic, keywords] of Object.entries(topicKeywords)) {
				const hits = keywords.filter((kw) => lower.includes(kw));
				if (hits.length >= 2) {
					if (!keyPhrases[topic]) {
						keyPhrases[topic] = { count: 0, sources: new Set() };
					}
					keyPhrases[topic].count++;
					// Categorize source by content hints
					if (lower.includes('fail') || lower.includes('error') || lower.includes('bug')) {
						keyPhrases[topic].sources.add('failure');
					} else if (lower.includes('complet') || lower.includes('success') || lower.includes('fixed')) {
						keyPhrases[topic].sources.add('success');
					} else {
						keyPhrases[topic].sources.add('learning');
					}
				}
			}
		}

		return Object.entries(keyPhrases)
			.filter(([, v]) => v.count >= 2)
			.sort((a, b) => b[1].count - a[1].count)
			.map(([topic, v]) => ({
				pattern: topic,
				occurrences: v.count,
				sources: Array.from(v.sources),
				identifiedAt: now,
			}));
	}

	/**
	 * Derive insights from memories and patterns.
	 *
	 * @param memories - Array of memory text strings
	 * @param patterns - Previously extracted patterns
	 * @returns Array of derived insights
	 */
	private deriveInsights(
		memories: string[],
		patterns: ConsolidatedPattern[]
	): ConsolidatedInsight[] {
		const insights: ConsolidatedInsight[] = [];

		// Insight: if a pattern appears in both failures and successes, it's a learning area
		for (const pattern of patterns) {
			if (pattern.sources.includes('failure') && pattern.sources.includes('success')) {
				insights.push({
					insight: `${pattern.pattern}: appears in both failures and successes — active learning area`,
					confidence: pattern.occurrences >= 4 ? 'high' : 'medium',
					relatedMemories: memories
						.filter((m) => m.toLowerCase().includes(pattern.pattern.split(' ')[0]))
						.slice(0, 3),
				});
			}
		}

		// Insight: high-frequency pattern suggests systematic behavior
		for (const pattern of patterns) {
			if (pattern.occurrences >= 4) {
				insights.push({
					insight: `${pattern.pattern}: recurring theme across ${pattern.occurrences} memories — may indicate systematic tendency`,
					confidence: 'high',
					relatedMemories: [],
				});
			}
		}

		return insights;
	}

	/**
	 * Persist consolidation report to disk.
	 *
	 * @param sessionName - Agent session name
	 * @param report - Consolidation report to save
	 */
	private async save(sessionName: string, report: ConsolidationReport): Promise<void> {
		const filePath = this.getFilePath(sessionName);
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
	}
}
