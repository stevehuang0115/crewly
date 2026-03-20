import * as fs from 'fs';
import * as path from 'path';
import { SoulModule } from './soul.module.js';
import { ModuleConfig } from './prompt-module.interface.js';

jest.mock('fs');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('SoulModule', () => {
	let module: SoulModule;

	const baseConfig: ModuleConfig = {
		sessionName: 'crewly-product-sam-217bfbbf',
		memberId: '217bfbbf-9c90-41ec-bf93-b7fca1b5934f',
		role: 'developer',
		teamId: '817a1aeb-b04e-45dd-bdbc-be5cbc4345f1',
		projectPath: '/Users/user/projects/crewly',
		agentSkillsPath: '/path/to/skills/agent',
		tlSkillsPath: '/path/to/skills/team-leader',
		projectRoot: '/path/to/project',
	};

	beforeEach(() => {
		module = new SoulModule();
		jest.resetAllMocks();
	});

	it('should have correct metadata', () => {
		expect(module.name).toBe('soul');
		expect(module.priority).toBe(2);
		expect(module.maxTokens).toBe(830);
		expect(module.compactable).toBe(false);
	});

	it('should always be included', () => {
		expect(module.shouldInclude(baseConfig)).toBe(true);
		expect(module.shouldInclude({ ...baseConfig, teamId: undefined })).toBe(true);
	});

	it('should load member soul when available (highest priority)', async () => {
		const memberSoulContent = '# Soul: Custom Sam\n\n## Working Style\n- TDD all the way';
		mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes('members') && p.endsWith('soul.md')) {
				return memberSoulContent;
			}
			throw new Error('ENOENT');
		});

		const result = await module.build(baseConfig);

		expect(result).toContain('## Your Soul');
		expect(result).toContain('_Source: personal_');
		expect(result).toContain('TDD all the way');
	});

	it('should fall back to role soul when no member soul exists', async () => {
		const roleSoulContent = '# Soul: Developer Default\n\n## Communication Style\n- Direct and technical';
		let callCount = 0;
		mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			callCount++;
			// First call is member soul — not found
			if (p.includes('members') && p.endsWith('soul.md')) {
				throw new Error('ENOENT');
			}
			// Second call is role soul — found
			if (p.includes(path.join('config', 'roles', 'developer', 'soul.md'))) {
				return roleSoulContent;
			}
			throw new Error('ENOENT');
		});

		const result = await module.build(baseConfig);

		expect(result).toContain('## Your Soul');
		expect(result).toContain('_Source: role default_');
		expect(result).toContain('Direct and technical');
	});

	it('should fall back to archetype soul when no role soul exists', async () => {
		const archetypeContent = '# Soul: Developer Archetype\n\n## Core Values\n- Simplicity';
		mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes(path.join('config', 'souls', 'developer.md'))) {
				return archetypeContent;
			}
			throw new Error('ENOENT');
		});

		const result = await module.build(baseConfig);

		expect(result).toContain('## Your Soul');
		expect(result).toContain('_Source: archetype_');
		expect(result).toContain('Simplicity');
	});

	it('should use hardcoded fallback when no soul files exist', async () => {
		mockedFs.readFileSync.mockImplementation(() => {
			throw new Error('ENOENT');
		});

		const result = await module.build(baseConfig);

		expect(result).toContain('## Your Soul');
		expect(result).toContain('professional, reliable team member');
	});

	it('should skip member soul check when teamId is missing', async () => {
		const roleSoulContent = '# Role soul\n\n## Style\n- Concise';
		mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			// Should NOT try to read member soul (no teamId)
			if (p.includes('members')) {
				throw new Error('Should not reach member path');
			}
			if (p.includes(path.join('config', 'roles'))) {
				return roleSoulContent;
			}
			throw new Error('ENOENT');
		});

		const configNoTeam = { ...baseConfig, teamId: undefined };
		const result = await module.build(configNoTeam);

		expect(result).toContain('_Source: role default_');
	});

	it('should handle empty soul file gracefully', async () => {
		mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes('members') && p.endsWith('soul.md')) {
				return '   \n  ';
			}
			throw new Error('ENOENT');
		});

		// Empty file after trim is falsy, should fall through to next level
		const result = await module.build(baseConfig);

		// Should not use the empty member soul — should fall to next level
		expect(result).toContain('## Your Soul');
	});

	it('should respect resolution order: member > role > archetype > fallback', async () => {
		// All levels exist, member should win
		mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes('members')) return '# Member soul\n\nMember personality';
			if (p.includes(path.join('config', 'roles'))) return '# Role soul\n\nRole personality';
			if (p.includes(path.join('config', 'souls'))) return '# Archetype soul\n\nArchetype personality';
			throw new Error('ENOENT');
		});

		const result = await module.build(baseConfig);
		expect(result).toContain('_Source: personal_');
		expect(result).toContain('Member personality');
	});
});
