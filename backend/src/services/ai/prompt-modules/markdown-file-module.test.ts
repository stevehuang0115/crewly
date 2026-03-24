import { buildMarkdownFileModule } from './markdown-file-module.js';
import type { ModuleConfig } from './prompt-module.interface.js';

describe('buildMarkdownFileModule', () => {
	const baseConfig: ModuleConfig = {
		sessionName: 'test-session',
		memberId: 'member-001',
		role: 'developer',
		agentSkillsPath: '/skills',
		tlSkillsPath: '/tl-skills',
		projectRoot: '/tmp/nonexistent-test-path',
	};

	const descriptor = {
		name: 'test-module',
		priority: 5,
		maxTokens: 500,
		compactable: true,
		configSubDir: 'test-dir',
		fileExtension: '.test.md',
		headingLabel: 'Test Module',
		missingFileHint: 'File not found at',
		getConfigValue: (config: ModuleConfig) => (config as any).testValue as string | undefined,
	};

	it('should create a module with correct metadata', () => {
		const module = buildMarkdownFileModule(descriptor);
		expect(module.name).toBe('test-module');
		expect(module.priority).toBe(5);
		expect(module.maxTokens).toBe(500);
		expect(module.compactable).toBe(true);
	});

	it('should not include when config value is undefined', () => {
		const module = buildMarkdownFileModule(descriptor);
		expect(module.shouldInclude(baseConfig)).toBe(false);
	});

	it('should include when config value is set', () => {
		const module = buildMarkdownFileModule(descriptor);
		const config = { ...baseConfig, testValue: 'some-value' } as any;
		expect(module.shouldInclude(config)).toBe(true);
	});

	it('should return fallback when file does not exist', async () => {
		const module = buildMarkdownFileModule(descriptor);
		const config = { ...baseConfig, testValue: 'missing-file' } as any;
		const result = await module.build(config);

		expect(result).toContain('## Test Module: missing-file');
		expect(result).toContain('File not found at');
		expect(result).toContain('missing-file.test.md');
	});
});
