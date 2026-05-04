/**
 * Tests for MissionContextModule — the live wire-in for mission/OKR
 * auto-injection (fix #415, replaces the dead PromptGeneratorService
 * hook).
 *
 * @module services/ai/prompt-modules/mission-context.module.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MissionContextModule } from './mission-context.module.js';
import type { ModuleConfig } from './prompt-module.interface.js';
import { MissionContextService } from '../../memory/mission-context.service.js';

/**
 * Build a minimal MissionContextService stub that records every call
 * and returns whatever the test sets up.
 */
function makeStubService(returnValue: string | Error): {
	service: MissionContextService;
	calls: Array<Parameters<MissionContextService['getContextForAgent']>[0]>;
} {
	const calls: Array<Parameters<MissionContextService['getContextForAgent']>[0]> = [];
	const service = {
		getContextForAgent: jest.fn(async (req: Parameters<MissionContextService['getContextForAgent']>[0]) => {
			calls.push(req);
			if (returnValue instanceof Error) throw returnValue;
			return returnValue;
		}),
	} as unknown as MissionContextService;
	return { service, calls };
}

const baseConfig: ModuleConfig = {
	sessionName: 'crewly-product-leo-21a5477e',
	memberId: '21a5477e-ec10-4e45-8cae-8b55e232e04e',
	role: 'developer',
	teamId: '28a4ac10-f37f-4286-ad8c-6926a0e177f5',
	projectPath: '/Users/me/projects/crewly',
	agentSkillsPath: '/path/to/skills/agent',
	tlSkillsPath: '/path/to/skills/team-leader',
	projectRoot: '/path/to/project',
};

describe('MissionContextModule', () => {
	beforeEach(() => {
		MissionContextService.clearInstance();
	});

	describe('metadata', () => {
		it('declares name=mission_context, priority=7, max=600, compactable=true', () => {
			const m = new MissionContextModule();
			expect(m.name).toBe('mission_context');
			expect(m.priority).toBe(7);
			expect(m.maxTokens).toBe(600);
			expect(m.compactable).toBe(true);
		});
	});

	describe('shouldInclude', () => {
		const m = new MissionContextModule();

		it('includes when teamId is set and not in eval mode', () => {
			expect(m.shouldInclude(baseConfig)).toBe(true);
		});

		it('skips when teamId is missing', () => {
			expect(m.shouldInclude({ ...baseConfig, teamId: undefined })).toBe(false);
		});

		it('skips in eval mode (token saving)', () => {
			expect(m.shouldInclude({ ...baseConfig, evalMode: true })).toBe(false);
		});
	});

	describe('build', () => {
		it('forwards sessionName, projectPath, teamId, teamSlug, ancestorTeamIds to service', async () => {
			const { service, calls } = makeStubService('## Current Mission Context\n\nActive Project OKR (90-day):\n- Cloud MVP launch by Q2');
			const m = new MissionContextModule(service);

			const result = await m.build({
				...baseConfig,
				teamSlug: 'product',
				teamAncestorIds: ['parent-team-1', 'company-team'],
			});

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				agentId: baseConfig.sessionName,
				projectPath: baseConfig.projectPath,
				teamId: baseConfig.teamId,
				ancestorTeamIds: ['parent-team-1', 'company-team'],
				teamSlug: 'product',
			});
			expect(result).toContain('## Current Mission Context');
		});

		it('does NOT use process.cwd() — uses config.projectPath verbatim', async () => {
			const { service, calls } = makeStubService('card');
			const m = new MissionContextModule(service);

			await m.build({ ...baseConfig, projectPath: '/explicit/project/path' });

			expect(calls[0].projectPath).toBe('/explicit/project/path');
			expect(calls[0].projectPath).not.toBe(process.cwd());
		});

		it('returns empty string when projectPath is missing (defensive guard)', async () => {
			const { service } = makeStubService('card');
			const m = new MissionContextModule(service);

			const result = await m.build({ ...baseConfig, projectPath: undefined });

			expect(result).toBe('');
		});

		it('returns empty string when teamId is missing (defensive guard)', async () => {
			const { service } = makeStubService('card');
			const m = new MissionContextModule(service);

			const result = await m.build({ ...baseConfig, teamId: undefined });

			expect(result).toBe('');
		});

		it('returns trimmed card content from service', async () => {
			const { service } = makeStubService('   \n## Card body\n   ');
			const m = new MissionContextModule(service);

			const result = await m.build(baseConfig);

			expect(result).toBe('## Card body');
		});

		it('returns empty string when service returns empty string', async () => {
			const { service } = makeStubService('');
			const m = new MissionContextModule(service);

			const result = await m.build(baseConfig);

			expect(result).toBe('');
		});

		it('is fail-soft: returns empty string when service throws', async () => {
			const { service } = makeStubService(new Error('mission file unparseable'));
			const m = new MissionContextModule(service);

			const result = await m.build(baseConfig);

			expect(result).toBe('');
		});

		it('passes undefined teamSlug through unchanged when caller did not supply one', async () => {
			const { service, calls } = makeStubService('card');
			const m = new MissionContextModule(service);

			await m.build(baseConfig);

			expect(calls[0].teamSlug).toBeUndefined();
		});

		it('passes undefined ancestorTeamIds when none configured', async () => {
			const { service, calls } = makeStubService('card');
			const m = new MissionContextModule(service);

			await m.build(baseConfig);

			expect(calls[0].ancestorTeamIds).toBeUndefined();
		});
	});
});
