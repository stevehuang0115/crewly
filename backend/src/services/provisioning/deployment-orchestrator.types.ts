/**
 * Deployment Orchestrator Types
 *
 * Type definitions for the deployment orchestration pipeline that bridges
 * DigitalOcean provisioning with the Crewly node setup scripts.
 *
 * @module services/provisioning/deployment-orchestrator.types
 */

// ---------------------------------------------------------------------------
// Deployment Phases
// ---------------------------------------------------------------------------

/** Ordered phases of a full-stack deployment. */
export enum DeploymentPhase {
  CREATING_DROPLET = 'CREATING_DROPLET',
  WAITING_FOR_DROPLET = 'WAITING_FOR_DROPLET',
  PROVISIONING_BASE = 'PROVISIONING_BASE',
  INSTALLING_OSS = 'INSTALLING_OSS',
  INSTALLING_PRO = 'INSTALLING_PRO',
  CONFIGURING_ACCOUNT = 'CONFIGURING_ACCOUNT',
  CONNECTING_CLOUD = 'CONNECTING_CLOUD',
  READY = 'READY',
  FAILED = 'FAILED',
}

/** Phases in execution order (excludes terminal states). */
export const DEPLOYMENT_PHASE_ORDER: readonly DeploymentPhase[] = [
  DeploymentPhase.CREATING_DROPLET,
  DeploymentPhase.WAITING_FOR_DROPLET,
  DeploymentPhase.PROVISIONING_BASE,
  DeploymentPhase.INSTALLING_OSS,
  DeploymentPhase.INSTALLING_PRO,
  DeploymentPhase.CONFIGURING_ACCOUNT,
  DeploymentPhase.CONNECTING_CLOUD,
  DeploymentPhase.READY,
] as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** API keys passed to the provisioning script as environment variables. */
export interface DeploymentApiKeys {
  /** Anthropic API key for Claude access. */
  anthropicApiKey?: string;
  /** Google API key for Gemini access. */
  googleApiKey?: string;
  /** Crewly Cloud API key for cloud connectivity. */
  crewlyCloudApiKey?: string;
}

/** Configuration for a full-stack deployment. */
export interface DeploymentConfig {
  /** Human-readable name for the Droplet. */
  dropletName: string;
  /** DigitalOcean region slug (e.g. 'nyc1', 'sfo3'). */
  region?: string;
  /** DigitalOcean size slug (e.g. 's-2vcpu-4gb'). */
  size?: string;
  /** SSH key IDs or fingerprints for Droplet access. */
  sshKeys?: (number | string)[];
  /** API keys to configure on the node. */
  apiKeys?: DeploymentApiKeys;
  /** Customer ID for Cloud registration. */
  customerId?: string;
  /** Whether to install Pro addon (default: false). */
  installPro?: boolean;
  /** Whether to register with Cloud (default: false). */
  registerCloud?: boolean;
  /** Path to the provisioning script (for testing). */
  provisionScriptPath?: string;
}

/** Configuration for Pro addon installation. */
export interface ProAddonConfig {
  /** License key for Pro features. */
  licenseKey?: string;
  /** Pro addon version to install. */
  version?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Result of a single deployment phase. */
export interface PhaseResult {
  /** Phase that was executed. */
  phase: DeploymentPhase;
  /** Whether the phase succeeded. */
  success: boolean;
  /** Human-readable message. */
  message: string;
  /** Duration of the phase in milliseconds. */
  durationMs: number;
  /** Error message if the phase failed. */
  error?: string;
}

/** Result of a complete deployment. */
export interface DeploymentResult {
  /** Unique deployment identifier. */
  deploymentId: string;
  /** Whether the entire deployment succeeded. */
  success: boolean;
  /** Current deployment phase. */
  currentPhase: DeploymentPhase;
  /** Droplet ID (set after creation). */
  dropletId?: number;
  /** Droplet public IP (set after Droplet is ready). */
  ipAddress?: string;
  /** Total duration of the deployment in milliseconds. */
  totalDurationMs: number;
  /** Per-phase results. */
  phases: PhaseResult[];
  /** Error message if the deployment failed. */
  error?: string;
}

/** Result of an SSH command execution. */
export interface SshCommandResult {
  /** Exit code of the command. */
  exitCode: number;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
}

// ---------------------------------------------------------------------------
// SSH Executor Interface (for dependency injection / testing)
// ---------------------------------------------------------------------------

/**
 * Interface for executing commands on a remote host via SSH.
 * Abstracted for testability — production uses child_process.exec,
 * tests use a mock.
 */
export interface ISshExecutor {
  /**
   * Execute a command on a remote host.
   *
   * @param host - Remote host IP or hostname
   * @param command - Command to execute
   * @param timeoutMs - Timeout in milliseconds (default: 300000)
   * @returns Command result with exit code, stdout, and stderr
   */
  execute(host: string, command: string, timeoutMs?: number): Promise<SshCommandResult>;
}

/**
 * Interface for the ProvisioningService dependency.
 * Abstracted for testability.
 */
export interface IProvisioningService {
  createDroplet(config: {
    name: string;
    region?: string;
    size?: string;
    sshKeys?: (number | string)[];
    tags?: string[];
  }): Promise<{ id: number; name: string; status: string; networks: Array<{ ipAddress: string; type: string }> }>;

  waitForDropletReady(dropletId: number, timeoutMs?: number): Promise<{
    id: number;
    name: string;
    status: string;
    networks: Array<{ ipAddress: string; type: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// Deployment Error
// ---------------------------------------------------------------------------

/** Error codes specific to deployment operations. */
export type DeploymentErrorCode =
  | 'DROPLET_CREATE_FAILED'
  | 'DROPLET_NOT_READY'
  | 'SSH_FAILED'
  | 'PROVISION_FAILED'
  | 'PRO_INSTALL_FAILED'
  | 'CLOUD_REGISTER_FAILED'
  | 'INVALID_CONFIG'
  | 'UNKNOWN';

/**
 * Custom error for deployment failures with phase context.
 */
export class DeploymentError extends Error {
  /** Structured error code. */
  readonly code: DeploymentErrorCode;
  /** Phase where the failure occurred. */
  readonly phase: DeploymentPhase;
  /** Associated deployment ID. */
  readonly deploymentId?: string;

  constructor(code: DeploymentErrorCode, message: string, phase: DeploymentPhase, deploymentId?: string) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.phase = phase;
    this.deploymentId = deploymentId;
  }
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Check whether a string is a valid DeploymentPhase.
 *
 * @param value - Value to check
 * @returns True if value is a valid DeploymentPhase
 */
export function isDeploymentPhase(value: unknown): value is DeploymentPhase {
  return typeof value === 'string' && Object.values(DeploymentPhase).includes(value as DeploymentPhase);
}

/**
 * Check whether a value is a DeploymentError.
 *
 * @param value - Value to check
 * @returns True if value is a DeploymentError
 */
export function isDeploymentError(value: unknown): value is DeploymentError {
  return value instanceof DeploymentError;
}

/**
 * Check whether a deployment phase is a terminal state.
 *
 * @param phase - Phase to check
 * @returns True if the phase is READY or FAILED
 */
export function isTerminalPhase(phase: DeploymentPhase): boolean {
  return phase === DeploymentPhase.READY || phase === DeploymentPhase.FAILED;
}
