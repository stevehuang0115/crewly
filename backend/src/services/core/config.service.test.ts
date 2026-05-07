import { ConfigService } from './config.service.js';

// Mock fs modules
jest.mock('fs/promises');
jest.mock('fs', () => ({
	existsSync: jest.fn(),
}));

const mockExistsSync = require('fs').existsSync as jest.MockedFunction<any>;

describe('ConfigService', () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Save original environment
		originalEnv = { ...process.env };

		// Clear environment variables
		delete process.env.PORT;
		delete process.env.CREWLY_MCP_PORT;
		delete process.env.NODE_ENV;

		jest.clearAllMocks();

		// Reset singleton
		(ConfigService as any).instance = undefined;
	});

	afterEach(() => {
		// Restore original environment
		process.env = originalEnv;
	});

	describe('Singleton Pattern', () => {
		test('should return the same instance', () => {
			const instance1 = ConfigService.getInstance();
			const instance2 = ConfigService.getInstance();

			expect(instance1).toBe(instance2);
		});
	});

	describe('Default Configuration', () => {
		test('should load default configuration when no config file exists', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const appConfig = config.getConfig();

			expect(appConfig.server.port).toBe(3000);
			expect(appConfig.mcp.port).toBe(3001);
			expect(appConfig.server.nodeEnv).toBe('development');
		});

		test('should use environment variables for configuration', () => {
			process.env.PORT = '4000';
			process.env.CREWLY_MCP_PORT = '4001';
			process.env.NODE_ENV = 'production';

			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const appConfig = config.getConfig();

			expect(appConfig.server.port).toBe(4000);
			expect(appConfig.mcp.port).toBe(4001);
			expect(appConfig.server.nodeEnv).toBe('production');
		});
	});

	describe('Configuration Sections', () => {
		test('should return specific configuration section', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const serverConfig = config.get('server');

			expect(serverConfig).toHaveProperty('port');
			expect(serverConfig).toHaveProperty('host');
			expect(serverConfig).toHaveProperty('nodeEnv');
		});
	});

	describe('Configuration Validation', () => {
		test('should validate valid configuration', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const validation = config.validateConfig();

			expect(validation.isValid).toBe(true);
			expect(validation.errors).toHaveLength(0);
		});

		test('should detect invalid port numbers', () => {
			process.env.PORT = '99999'; // Invalid port
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const validation = config.validateConfig();

			expect(validation.isValid).toBe(false);
			expect(validation.errors).toContain('Server port must be between 1 and 65535');
		});

		test('should detect port conflicts', () => {
			process.env.PORT = '3000';
			process.env.CREWLY_MCP_PORT = '3000'; // Same as server port
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const validation = config.validateConfig();

			expect(validation.isValid).toBe(false);
			expect(validation.errors).toContain('MCP port cannot be the same as server port');
		});

		test('should require session secret in production', () => {
			process.env.NODE_ENV = 'production';
			delete process.env.SESSION_SECRET;
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const validation = config.validateConfig();

			expect(validation.isValid).toBe(false);
			expect(validation.errors).toContain('Session secret is required in production');
		});
	});

	describe('Environment Helpers', () => {
		test('should detect development environment', () => {
			process.env.NODE_ENV = 'development';
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();

			expect(config.isDevelopment()).toBe(true);
			expect(config.isProduction()).toBe(false);
			expect(config.isTest()).toBe(false);
		});

		test('should detect production environment', () => {
			process.env.NODE_ENV = 'production';
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();

			expect(config.isDevelopment()).toBe(false);
			expect(config.isProduction()).toBe(true);
			expect(config.isTest()).toBe(false);
		});

		test('should detect test environment', () => {
			process.env.NODE_ENV = 'test';
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();

			expect(config.isDevelopment()).toBe(false);
			expect(config.isProduction()).toBe(false);
			expect(config.isTest()).toBe(true);
		});
	});

	describe('Environment Info', () => {
		test('should return environment information', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const envInfo = config.getEnvironmentInfo();

			expect(envInfo).toHaveProperty('nodeVersion');
			expect(envInfo).toHaveProperty('platform');
			expect(envInfo).toHaveProperty('architecture');
			expect(envInfo).toHaveProperty('processId');
			expect(envInfo).toHaveProperty('uptime');
			expect(envInfo).toHaveProperty('memoryUsage');
		});
	});

	describe('Boolean Environment Variables', () => {
		test('should parse boolean environment variables correctly', () => {
			process.env.MCP_ENABLED = 'false';
			process.env.BACKUP_ENABLED = 'true';
			process.env.RATE_LIMIT_ENABLED = 'false';

			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const appConfig = config.getConfig();

			expect(appConfig.mcp.enabled).toBe(false);
			expect(appConfig.storage.backupEnabled).toBe(true);
			expect(appConfig.security.rateLimitEnabled).toBe(false);
		});
	});

	describe('Array Environment Variables', () => {
		test('should parse comma-separated array environment variables', () => {
			process.env.CORS_ORIGIN =
				'http://localhost:3000,http://localhost:3001,https://example.com';

			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const appConfig = config.getConfig();

			expect(appConfig.server.corsOrigin).toEqual([
				'http://localhost:3000',
				'http://localhost:3001',
				'https://example.com',
			]);
		});
	});

	describe('Numeric Environment Variables', () => {
		test('should parse numeric environment variables with defaults', () => {
			process.env.MAX_CONCURRENT_AGENTS = '25';
			process.env.CONTEXT_REFRESH_INTERVAL = '900000'; // 15 minutes

			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const appConfig = config.getConfig();

			expect(appConfig.agents.maxConcurrentAgents).toBe(25);
			expect(appConfig.agents.contextRefreshInterval).toBe(900000);
		});

		test('should use default values for missing numeric environment variables', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const appConfig = config.getConfig();

			expect(appConfig.agents.maxConcurrentAgents).toBe(50);
			expect(appConfig.agents.defaultTimeout).toBe(300000); // 5 minutes
			expect(appConfig.monitoring.memoryThreshold).toBe(512);
		});
	});

	describe('Logging Configuration', () => {
		test('should have valid logging configuration', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const loggingConfig = config.get('logging');

			expect(['error', 'warn', 'info', 'debug']).toContain(loggingConfig.level);
			expect(['json', 'simple']).toContain(loggingConfig.format);
			expect(typeof loggingConfig.enableFileLogging).toBe('boolean');
			expect(typeof loggingConfig.logDir).toBe('string');
		});

		// =====================================================================
		// WI-F (2026-05-07) — CREWLY_HOME isolation regression for logDir
		//
		// Mia's KR3 livewalk on 2026-05-07 02:37Z found the test backend
		// interleaving 52 references of /tmp/crewly-kr3-livewalk-* into
		// Steve's user-prod `~/.crewly/logs/crewly-2026-05-07.log` because
		// the default `logDir` ignored CREWLY_HOME and went straight to
		// `os.homedir()`. Same shape as the PR #452 9-site sweep but on a
		// missed vector. These guards lock the resolution semantics in.
		// =====================================================================
		describe('logDir CREWLY_HOME isolation (WI-F)', () => {
			test('honours CREWLY_HOME when set (no LOG_DIR override)', () => {
				mockExistsSync.mockReturnValue(false);
				process.env.CREWLY_HOME = '/tmp/crewly-test-profile-xyz';
				delete process.env.LOG_DIR;

				const config = ConfigService.getInstance();
				const { logDir } = config.get('logging');

				expect(logDir).toBe('/tmp/crewly-test-profile-xyz/logs');
				// Negative: must NOT have leaked into the developer's home dir.
				expect(logDir.startsWith(require('os').homedir())).toBe(false);
			});

			test('falls back to ~/.crewly/logs when CREWLY_HOME is unset', () => {
				mockExistsSync.mockReturnValue(false);
				delete process.env.CREWLY_HOME;
				delete process.env.LOG_DIR;

				const config = ConfigService.getInstance();
				const { logDir } = config.get('logging');

				const path = require('path');
				const os = require('os');
				expect(logDir).toBe(path.join(os.homedir(), '.crewly', 'logs'));
			});

			test('treats empty-string CREWLY_HOME as unset', () => {
				mockExistsSync.mockReturnValue(false);
				process.env.CREWLY_HOME = '';
				delete process.env.LOG_DIR;

				const config = ConfigService.getInstance();
				const { logDir } = config.get('logging');

				const path = require('path');
				const os = require('os');
				expect(logDir).toBe(path.join(os.homedir(), '.crewly', 'logs'));
			});

			test('LOG_DIR explicit override still wins over CREWLY_HOME', () => {
				mockExistsSync.mockReturnValue(false);
				process.env.CREWLY_HOME = '/tmp/crewly-test-profile-xyz';
				process.env.LOG_DIR = '/var/log/crewly-explicit';

				const config = ConfigService.getInstance();
				const { logDir } = config.get('logging');

				expect(logDir).toBe('/var/log/crewly-explicit');
			});
		});
	});

	describe('Security Configuration', () => {
		test('should have secure defaults', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const securityConfig = config.get('security');

			expect(securityConfig.rateLimitEnabled).toBe(true);
			expect(securityConfig.enableHelmet).toBe(true);
			expect(securityConfig.rateLimitWindow).toBeGreaterThan(0);
			expect(securityConfig.rateLimitMax).toBeGreaterThan(0);
		});
	});

	describe('WebSocket Configuration', () => {
		test('should have reasonable WebSocket defaults', () => {
			mockExistsSync.mockReturnValue(false);

			const config = ConfigService.getInstance();
			const wsConfig = config.get('websocket');

			expect(wsConfig.enabled).toBe(true);
			expect(wsConfig.pingTimeout).toBeGreaterThan(0);
			expect(wsConfig.pingInterval).toBeGreaterThan(0);
			expect(wsConfig.maxConnections).toBeGreaterThan(0);
		});
	});
});
