/**
 * Agent memory provider for {@link MemoryConsolidationService}.
 *
 * The consolidation service takes a `MemoryProvider` — a function returning
 * an agent's memories as plain strings — so it can be unit-tested without
 * touching disk. This module supplies the production provider: it reads the
 * agent's role knowledge (facts / patterns / gotchas stored via `remember`)
 * and the error patterns recorded against the agent, and flattens both into
 * the text list the consolidation pass analyses.
 *
 * Every caller that needs a real consolidation service (the daily sweep, the
 * REST controller, the prompt module) goes through {@link createMemoryConsolidationService}
 * so they all see the same memory surface.
 *
 * @module services/ai/self-improvement/agent-memory-provider
 */

import type { IAgentMemoryService } from '../../memory/agent-memory.service.js';
import { AgentMemoryService } from '../../memory/agent-memory.service.js';
import { MemoryConsolidationService, type MemoryProvider } from './memory-consolidation.service.js';

/**
 * Narrow surface of {@link IAgentMemoryService} the provider depends on.
 * Structural so tests can pass a stub without the singleton.
 */
export type AgentMemoryReader = Pick<IAgentMemoryService, 'getAgentMemory'>;

/**
 * Build a memory provider backed by the agent memory store.
 *
 * Role-knowledge entries contribute their `content`; error patterns
 * contribute `pattern` plus the known resolution (when present) so a fix
 * that was applied counts as a "success" source in consolidation. Any read
 * failure yields an empty list — consolidation is a best-effort sweep and
 * must never throw because one agent's memory file is unreadable.
 *
 * @param reader - Agent memory reader (defaults to the singleton service)
 * @returns A provider that resolves the agent's memories as strings
 */
export function createAgentMemoryProvider(reader?: AgentMemoryReader): MemoryProvider {
	return async (sessionName: string): Promise<string[]> => {
		try {
			const memoryReader = reader ?? AgentMemoryService.getInstance();
			const memory = await memoryReader.getAgentMemory(sessionName);
			if (!memory) return [];

			const knowledge = (memory.roleKnowledge ?? [])
				.map((entry) => entry.content)
				.filter((text): text is string => typeof text === 'string' && text.trim().length > 0);

			const errors = (memory.performance?.commonErrors ?? []).map((err) =>
				err.resolution ? `${err.pattern} — fixed: ${err.resolution}` : `error: ${err.pattern}`
			);

			return [...knowledge, ...errors];
		} catch {
			return [];
		}
	};
}

/**
 * Construct a {@link MemoryConsolidationService} wired to the real agent
 * memory store.
 *
 * @param reader - Optional agent memory reader override (tests)
 * @returns Consolidation service ready to `consolidate()` / `getReport()`
 */
export function createMemoryConsolidationService(reader?: AgentMemoryReader): MemoryConsolidationService {
	return new MemoryConsolidationService(createAgentMemoryProvider(reader));
}
