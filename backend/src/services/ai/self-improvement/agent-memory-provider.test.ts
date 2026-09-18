/**
 * Tests for the agent memory provider that feeds memory consolidation.
 *
 * @module services/ai/self-improvement/agent-memory-provider.test
 */

import type { AgentMemory } from '../../../types/memory.types.js';
import { createAgentMemoryProvider, createMemoryConsolidationService } from './agent-memory-provider.js';
import { MemoryConsolidationService } from './memory-consolidation.service.js';

/**
 * Build a minimal AgentMemory fixture.
 *
 * @param overrides - Partial fields to override
 * @returns A full AgentMemory object
 */
function makeMemory(overrides: Partial<AgentMemory> = {}): AgentMemory {
	return {
		agentId: 'crewly-dev-1',
		role: 'developer',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		roleKnowledge: [],
		preferences: {} as AgentMemory['preferences'],
		performance: { commonErrors: [] } as unknown as AgentMemory['performance'],
		...overrides,
	};
}

describe('createAgentMemoryProvider', () => {
	it('flattens role knowledge content and error patterns into strings', async () => {
		const reader = {
			getAgentMemory: jest.fn(async () =>
				makeMemory({
					roleKnowledge: [
						{ id: 'k1', category: 'best-practice', content: 'Run tests before commit', confidence: 0.5, createdAt: 'x' },
						{ id: 'k2', category: 'best-practice', content: '   ', confidence: 0.5, createdAt: 'x' },
					] as unknown as AgentMemory['roleKnowledge'],
					performance: {
						commonErrors: [
							{ pattern: 'ENOENT on teams.json', occurrences: 2, lastOccurred: 'x', resolution: 'create the file' },
							{ pattern: 'jest timeout', occurrences: 1, lastOccurred: 'x' },
						],
					} as unknown as AgentMemory['performance'],
				})
			),
		};

		const provider = createAgentMemoryProvider(reader);
		const memories = await provider('crewly-dev-1');

		expect(reader.getAgentMemory).toHaveBeenCalledWith('crewly-dev-1');
		expect(memories).toEqual([
			'Run tests before commit',
			'ENOENT on teams.json — fixed: create the file',
			'error: jest timeout',
		]);
	});

	it('returns an empty list when the agent has no memory file', async () => {
		const reader = { getAgentMemory: jest.fn(async () => null) };
		const memories = await createAgentMemoryProvider(reader)('nobody');
		expect(memories).toEqual([]);
	});

	it('swallows reader failures so consolidation stays best-effort', async () => {
		const reader = {
			getAgentMemory: jest.fn(async () => {
				throw new Error('disk on fire');
			}),
		};
		await expect(createAgentMemoryProvider(reader)('x')).resolves.toEqual([]);
	});
});

describe('createMemoryConsolidationService', () => {
	it('returns a consolidation service backed by the provider', async () => {
		const reader = { getAgentMemory: jest.fn(async () => null) };
		const service = createMemoryConsolidationService(reader);
		expect(service).toBeInstanceOf(MemoryConsolidationService);
	});
});
