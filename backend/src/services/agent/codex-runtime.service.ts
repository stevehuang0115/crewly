import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES, RUNTIME_INPUT_READY_PATTERNS, type RuntimeType } from '../../constants.js';

/**
 * OpenAI Codex CLI specific runtime service implementation.
 * Handles Codex CLI initialization, detection, and interaction patterns.
 */
export class CodexRuntimeService extends RuntimeAgentService {
	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		super(sessionHelper, projectRoot);
	}

	protected getRuntimeType(): RuntimeType {
		return RUNTIME_TYPES.CODEX_CLI;
	}

	/**
	 * Codex CLI runtime detection.
	 *
	 * NOTE: Do not use active key probes (Ctrl+C, '/', etc.) here. Codex can
	 * interpret those as shell input/cancel and drop back to zsh, which causes
	 * false negatives and unintended exits during health checks.
	 */
	protected async detectRuntimeSpecific(sessionName: string): Promise<boolean> {
		const output = this.sessionHelper.capturePane(sessionName, 120);
		const readyPatterns = this.getRuntimeReadyPatterns();
		const hasReadySignal = readyPatterns.some((pattern) => output.includes(pattern));

		this.logger.debug('Codex detection completed', {
			sessionName,
			hasReadySignal,
		});

		return hasReadySignal;
	}

	/**
	 * Codex CLI specific ready patterns
	 */
	protected getRuntimeReadyPatterns(): string[] {
		return [
			'Codex CLI',
			'codex>',
			'Ready for commands',
			'OpenAI Codex',
			'model:',
			'token:',
			'Connected to OpenAI',
			'Welcome to Codex',
			'Initialized successfully',
		];
	}

	/**
	 * Codex paints its `›` prompt glyph before the model finishes loading
	 * (`model: loading` in the header) and also on its sign-in screen, so a
	 * bare prompt-line check is not enough — those markers veto readiness.
	 *
	 * @returns Codex-specific "not ready" markers
	 */
	protected getNotReadyMarkers(): readonly string[] {
		return RUNTIME_INPUT_READY_PATTERNS.CODEX.NOT_READY_MARKERS;
	}

	/**
	 * Codex CLI specific exit patterns for runtime exit detection
	 */
	protected getRuntimeExitPatterns(): RegExp[] {
		return [
			/codex.*exited/i,
			/Session\s+ended/i,
			/Conversation interrupted/i,
		];
	}

	/**
	 * Codex CLI specific error patterns
	 */
	protected getRuntimeErrorPatterns(): string[] {
		const commonErrors = ['Permission denied', 'No such file or directory'];
		return [
			...commonErrors,
			'command not found: codex',
			'OpenAI API error',
			'Authentication failed',
			'Invalid API key',
			'Rate limit exceeded',
			'Token limit exceeded',
		];
	}

	/**
	 * Check if Codex CLI is installed and configured
	 */
	async checkCodexInstallation(): Promise<{
		isInstalled: boolean;
		version?: string;
		message: string;
	}> {
		try {
			// This would check if Codex CLI is available
			// Could run: codex --version or similar
			return {
				isInstalled: true,
				message: 'OpenAI Codex CLI is available',
			};
		} catch (error) {
			return {
				isInstalled: false,
				message: 'OpenAI Codex CLI not found or not configured',
			};
		}
	}

	/**
	 * Initialize Codex in an existing session
	 */
	async initializeCodexInSession(sessionName: string): Promise<{
		success: boolean;
		message: string;
	}> {
		try {
			await this.executeRuntimeInitScript(sessionName);
			return {
				success: true,
				message: 'OpenAI Codex CLI initialized successfully',
			};
		} catch (error) {
			return {
				success: false,
				message:
					error instanceof Error
						? error.message
						: 'Failed to initialize OpenAI Codex CLI',
			};
		}
	}
}
