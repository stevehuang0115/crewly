// ExpertProfileModule integration
import {
	estimateTokens,
	PromptModule,
	ModuleConfig,
	loadRoleFragment,
	isPromptProfile,
	resolveOrcPromptProfile,
	ORC_PROMPT_PROFILE_ENV,
	DEFAULT_PROMPT_PROFILE,
} from './prompt-module.interface.js';

// Mock fs
jest.mock('fs', () => ({
	existsSync: jest.fn(),
	readFileSync: jest.fn(),
}));

describe('prompt-module.interface', () => {
	describe('estimateTokens', () => {
		it('should return 0 for empty string', () => {
			expect(estimateTokens('')).toBe(0);
		});

		it('should return 0 for null/undefined input', () => {
			expect(estimateTokens(null as unknown as string)).toBe(0);
			expect(estimateTokens(undefined as unknown as string)).toBe(0);
		});

		it('should estimate tokens at ~4 chars per token', () => {
			// 20 chars → ~5 tokens
			expect(estimateTokens('12345678901234567890')).toBe(5);
		});

		it('should ceil the result', () => {
			// 5 chars → ceil(5/4) = 2
			expect(estimateTokens('hello')).toBe(2);
		});

		it('should handle long strings', () => {
			const longText = 'a'.repeat(1000);
			expect(estimateTokens(longText)).toBe(250);
		});
	});

	describe('loadRoleFragment', () => {
		it('should return fragment content when file exists', () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValueOnce(true);
			fs.readFileSync.mockReturnValueOnce('# Fragment Content\nHello');

			const result = loadRoleFragment('/project', 'orchestrator', 'communication');
			expect(result).toBe('# Fragment Content\nHello');
			expect(fs.existsSync).toHaveBeenCalledWith(
				expect.stringContaining('config/roles/orchestrator/fragments/communication.md')
			);
		});

		it('should return null when file does not exist', () => {
			const fs = require('fs');
			fs.existsSync.mockReturnValueOnce(false);

			const result = loadRoleFragment('/project', 'developer', 'lifecycle');
			expect(result).toBeNull();
		});

		it('should return null on read error', () => {
			const fs = require('fs');
			fs.existsSync.mockImplementationOnce(() => { throw new Error('permission denied'); });

			const result = loadRoleFragment('/project', 'developer', 'recovery');
			expect(result).toBeNull();
		});
	});

	describe('PromptModule interface', () => {
		it('should allow creating a valid PromptModule implementation', () => {
			const module: PromptModule = {
				name: 'test',
				priority: 1,
				maxTokens: 100,
				compactable: false,
				shouldInclude: (_config: ModuleConfig) => true,
				build: async (_config: ModuleConfig) => 'test content',
			};

			expect(module.name).toBe('test');
			expect(module.priority).toBe(1);
			expect(module.maxTokens).toBe(100);
			expect(module.compactable).toBe(false);
		});

		it('should support async build method', async () => {
			const module: PromptModule = {
				name: 'async-test',
				priority: 5,
				maxTokens: 200,
				compactable: true,
				shouldInclude: () => true,
				build: async (config: ModuleConfig) => `Hello ${config.sessionName}`,
			};

			const config: ModuleConfig = {
				sessionName: 'test-session',
				memberId: 'member-001',
				role: 'developer',
				agentSkillsPath: '/path/to/skills',
				tlSkillsPath: '/path/to/tl-skills',
				projectRoot: '/path/to/project',
			};

			const result = await module.build(config);
			expect(result).toBe('Hello test-session');
		});
	});

	describe('prompt profile helpers', () => {
		it('isPromptProfile accepts only known profiles', () => {
			expect(isPromptProfile('full')).toBe(true);
			expect(isPromptProfile('lite')).toBe(true);
			expect(isPromptProfile('LITE')).toBe(false);
			expect(isPromptProfile('')).toBe(false);
			expect(isPromptProfile(undefined)).toBe(false);
			expect(isPromptProfile(42)).toBe(false);
		});

		it('resolveOrcPromptProfile defaults to full when the env is unset', () => {
			expect(DEFAULT_PROMPT_PROFILE).toBe('full');
			expect(resolveOrcPromptProfile({})).toBe('full');
		});

		it('resolveOrcPromptProfile reads CREWLY_ORC_PROMPT_PROFILE case-insensitively', () => {
			expect(ORC_PROMPT_PROFILE_ENV).toBe('CREWLY_ORC_PROMPT_PROFILE');
			expect(resolveOrcPromptProfile({ [ORC_PROMPT_PROFILE_ENV]: 'lite' })).toBe('lite');
			expect(resolveOrcPromptProfile({ [ORC_PROMPT_PROFILE_ENV]: ' Lite ' })).toBe('lite');
			expect(resolveOrcPromptProfile({ [ORC_PROMPT_PROFILE_ENV]: 'full' })).toBe('full');
		});

		it('resolveOrcPromptProfile falls back to full on garbage', () => {
			expect(resolveOrcPromptProfile({ [ORC_PROMPT_PROFILE_ENV]: 'tiny' })).toBe('full');
			expect(resolveOrcPromptProfile({ [ORC_PROMPT_PROFILE_ENV]: '' })).toBe('full');
		});
	});
});
