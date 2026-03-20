import { ContextAssemblyService, ContextLoaderConfig } from './context-assembly.service.js';

// Mock logger
jest.mock('../../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn().mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

describe('ContextAssemblyService', () => {
	const baseLoaderConfig: ContextLoaderConfig = {
		agentId: 'crewly-dev-001',
		role: 'developer',
		projectPath: '/project',
		teamId: 'team-001',
	};

	describe('constructor', () => {
		it('should use default token budget of 15000', () => {
			const service = new ContextAssemblyService();
			expect(service.tokenBudget()).toBe(15000);
		});

		it('should accept custom token budget', () => {
			const service = new ContextAssemblyService(5000);
			expect(service.tokenBudget()).toBe(5000);
		});
	});

	describe('registerLoader / removeLoader', () => {
		it('should register a context loader', () => {
			const service = new ContextAssemblyService();
			service.registerLoader('memory', async () => 'memory data');

			expect(service.getLoaderNames()).toContain('memory');
		});

		it('should remove a context loader', () => {
			const service = new ContextAssemblyService();
			service.registerLoader('memory', async () => 'memory data');
			service.removeLoader('memory');

			expect(service.getLoaderNames()).not.toContain('memory');
		});

		it('should clear cache when removing loader', () => {
			const service = new ContextAssemblyService();
			service.registerLoader('memory', async () => 'data');
			service.removeLoader('memory');

			expect(service.getCached('memory')).toBeNull();
		});
	});

	describe('load', () => {
		it('should load a single context module', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('memory', async () => 'memory data');

			const result = await service.load('memory', baseLoaderConfig);

			expect(result).not.toBeNull();
			expect(result!.name).toBe('memory');
			expect(result!.content).toBe('memory data');
			expect(result!.estimatedTokens).toBeGreaterThan(0);
			expect(result!.loadedAt).toBeInstanceOf(Date);
		});

		it('should return null for unregistered loader', async () => {
			const service = new ContextAssemblyService();
			const result = await service.load('nonexistent', baseLoaderConfig);
			expect(result).toBeNull();
		});

		it('should cache the result', async () => {
			const service = new ContextAssemblyService();
			let callCount = 0;
			service.registerLoader('memory', async () => {
				callCount++;
				return 'data';
			});

			await service.load('memory', baseLoaderConfig);
			const cached = service.getCached('memory');

			expect(cached).not.toBeNull();
			expect(cached!.content).toBe('data');
			expect(callCount).toBe(1);
		});

		it('should use cache when useCache=true', async () => {
			const service = new ContextAssemblyService();
			let callCount = 0;
			service.registerLoader('memory', async () => {
				callCount++;
				return `data-${callCount}`;
			});

			await service.load('memory', baseLoaderConfig);
			const result = await service.load('memory', baseLoaderConfig, true);

			expect(result!.content).toBe('data-1');
			expect(callCount).toBe(1); // Not called again
		});

		it('should reload when useCache=false', async () => {
			const service = new ContextAssemblyService();
			let callCount = 0;
			service.registerLoader('memory', async () => {
				callCount++;
				return `data-${callCount}`;
			});

			await service.load('memory', baseLoaderConfig);
			const result = await service.load('memory', baseLoaderConfig, false);

			expect(result!.content).toBe('data-2');
			expect(callCount).toBe(2);
		});

		it('should handle loader errors gracefully', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('broken', async () => { throw new Error('load failed'); });

			const result = await service.load('broken', baseLoaderConfig);
			expect(result).toBeNull();
		});
	});

	describe('loadAll', () => {
		it('should load all registered loaders', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('memory', async () => 'memory data');
			service.registerLoader('team', async () => 'team data');

			const result = await service.loadAll(baseLoaderConfig);

			expect(result).toContain('memory data');
			expect(result).toContain('team data');
		});

		it('should separate context modules with ---', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('first', async () => 'first-content');
			service.registerLoader('second', async () => 'second-content');

			const result = await service.loadAll(baseLoaderConfig);

			expect(result).toContain('---');
		});

		it('should skip empty context results', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('with-data', async () => 'data');
			service.registerLoader('empty', async () => '');

			const result = await service.loadAll(baseLoaderConfig);

			expect(result).toBe('data');
		});

		it('should respect token budget', async () => {
			const service = new ContextAssemblyService(100); // Budget for ~100 tokens
			service.registerLoader('small', async () => 'small data'); // ~3 tokens, fits
			service.registerLoader('large', async () => 'x'.repeat(500)); // ~125 tokens, would exceed

			const result = await service.loadAll(baseLoaderConfig);

			expect(result).toContain('small data');
			expect(result).not.toContain('x'.repeat(500));
		});

		it('should skip contexts that would exceed budget', async () => {
			const service = new ContextAssemblyService(30);
			service.registerLoader('first', async () => 'a'.repeat(100)); // ~25 tokens
			service.registerLoader('second', async () => 'b'.repeat(100)); // ~25 tokens, would exceed

			const result = await service.loadAll(baseLoaderConfig);

			expect(result).toContain('a'.repeat(100));
			expect(result).not.toContain('b'.repeat(100));
		});

		it('should handle loader errors gracefully in loadAll', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('ok', async () => 'ok-data');
			service.registerLoader('broken', async () => { throw new Error('fail'); });

			const result = await service.loadAll(baseLoaderConfig);

			expect(result).toBe('ok-data');
		});

		it('should return empty string when no loaders registered', async () => {
			const service = new ContextAssemblyService();
			const result = await service.loadAll(baseLoaderConfig);
			expect(result).toBe('');
		});
	});

	describe('refresh', () => {
		it('should clear cache and reload', async () => {
			const service = new ContextAssemblyService();
			let callCount = 0;
			service.registerLoader('memory', async () => {
				callCount++;
				return `data-${callCount}`;
			});

			await service.load('memory', baseLoaderConfig);
			const refreshed = await service.refresh('memory', baseLoaderConfig);

			expect(refreshed!.content).toBe('data-2');
			expect(callCount).toBe(2);
		});
	});

	describe('clearCache', () => {
		it('should clear all cached context', async () => {
			const service = new ContextAssemblyService();
			service.registerLoader('a', async () => 'data-a');
			service.registerLoader('b', async () => 'data-b');

			await service.load('a', baseLoaderConfig);
			await service.load('b', baseLoaderConfig);

			service.clearCache();

			expect(service.getCached('a')).toBeNull();
			expect(service.getCached('b')).toBeNull();
		});
	});

	describe('tokenBudget', () => {
		it('should get current budget', () => {
			const service = new ContextAssemblyService(8000);
			expect(service.tokenBudget()).toBe(8000);
		});

		it('should set new budget', () => {
			const service = new ContextAssemblyService();
			service.tokenBudget(5000);
			expect(service.tokenBudget()).toBe(5000);
		});
	});

	describe('compactRefresh', () => {
		it('should reload context with reduced budget', async () => {
			const service = new ContextAssemblyService(15000);
			service.registerLoader('small', async () => 'small data');
			service.registerLoader('large', async () => 'x'.repeat(500));

			// First load with full budget
			const full = await service.loadAll(baseLoaderConfig);
			expect(full).toContain('small data');
			expect(full).toContain('x'.repeat(500));

			// Compact refresh with tiny budget
			const compact = await service.compactRefresh(baseLoaderConfig, 30);
			expect(compact).toContain('small data');
			expect(compact).not.toContain('x'.repeat(500));
		});

		it('should restore original budget after compact refresh', async () => {
			const service = new ContextAssemblyService(15000);
			service.registerLoader('test', async () => 'data');

			await service.compactRefresh(baseLoaderConfig, 5000);

			// Budget should be restored to original
			expect(service.tokenBudget()).toBe(15000);
		});

		it('should clear cache before reloading', async () => {
			const service = new ContextAssemblyService(15000);
			let callCount = 0;
			service.registerLoader('counter', async () => {
				callCount++;
				return `data-${callCount}`;
			});

			// First load caches
			await service.loadAll(baseLoaderConfig);
			expect(callCount).toBe(1);

			// Compact refresh should force reload (cache cleared)
			await service.compactRefresh(baseLoaderConfig, 15000);
			expect(callCount).toBe(2);
		});

		it('should return empty string when budget is too small for any loader', async () => {
			const service = new ContextAssemblyService(15000);
			service.registerLoader('large', async () => 'x'.repeat(100));

			const result = await service.compactRefresh(baseLoaderConfig, 1);
			expect(result).toBe('');
		});
	});
});
