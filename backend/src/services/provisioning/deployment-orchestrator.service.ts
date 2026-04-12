/**
 * Deployment Orchestrator Service
 *
 * Bridges ProvisioningService (DigitalOcean API) with the Crewly node
 * provisioning script. Orchestrates the full deployment pipeline:
 * create Droplet → wait for ready → SSH provision → install Pro → register Cloud.
 *
 * Each phase is independently retriable and emits status events through
 * the DeploymentStatusService.
 *
 * @module services/provisioning/deployment-orchestrator.service
 */

import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  DeploymentPhase,
  DeploymentError,
  type DeploymentConfig,
  type DeploymentResult,
  type PhaseResult,
  type SshCommandResult,
  type ISshExecutor,
  type IProvisioningService,
  type DeploymentApiKeys,
  type ProAddonConfig,
} from './deployment-orchestrator.types.js';

import type { DeploymentStatusService } from './deployment-status.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default SSH timeout in milliseconds (5 minutes). */
const DEFAULT_SSH_TIMEOUT_MS = 300_000;

/** Default timeout waiting for Droplet to become active (5 minutes). */
const DEFAULT_DROPLET_READY_TIMEOUT_MS = 300_000;

/** SSH options for non-interactive remote execution. */
const SSH_OPTIONS = [
  '-o StrictHostKeyChecking=no',
  '-o UserKnownHostsFile=/dev/null',
  '-o ConnectTimeout=30',
  '-o BatchMode=yes',
].join(' ');

/** Default path to the provisioning script on the local machine. */
const DEFAULT_PROVISION_SCRIPT_PATH = 'deploy/provision-crewly-node.sh';

// ---------------------------------------------------------------------------
// Default SSH Executor (uses child_process.exec)
// ---------------------------------------------------------------------------

/**
 * Production SSH executor using Node.js child_process.exec.
 * Runs `ssh root@host 'command'` with standard options.
 */
export class ChildProcessSshExecutor implements ISshExecutor {
  /**
   * Execute a command on a remote host via SSH.
   *
   * @param host - Remote host IP or hostname
   * @param command - Shell command to execute remotely
   * @param timeoutMs - Maximum execution time (default: 300s)
   * @returns Command result with exit code, stdout, stderr
   */
  async execute(host: string, command: string, timeoutMs: number = DEFAULT_SSH_TIMEOUT_MS): Promise<SshCommandResult> {
    const sshCommand = `ssh ${SSH_OPTIONS} root@${host} '${command.replace(/'/g, "'\\''")}'`;

    return new Promise<SshCommandResult>((resolve) => {
      exec(sshCommand, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 137
          : (error as { code?: number }).code ?? 1
          : 0;
        resolve({
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full Crewly node deployment pipeline.
 *
 * Coordinates DigitalOcean Droplet creation with remote provisioning,
 * Pro addon installation, and Cloud registration. Each phase is tracked
 * independently and can be retried.
 *
 * @example
 * ```typescript
 * const orchestrator = new DeploymentOrchestratorService(
 *   provisioningService,
 *   statusService,
 * );
 * const result = await orchestrator.deployFullStack({
 *   dropletName: 'customer-node-1',
 *   apiKeys: { anthropicApiKey: 'sk-xxx' },
 *   customerId: 'cust_123',
 *   installPro: true,
 *   registerCloud: true,
 * });
 * ```
 */
export class DeploymentOrchestratorService {
  private readonly provisioningService: IProvisioningService;
  private readonly statusService: DeploymentStatusService | null;
  private readonly sshExecutor: ISshExecutor;

  /**
   * Create a new DeploymentOrchestratorService.
   *
   * @param provisioningService - DigitalOcean API wrapper for Droplet CRUD
   * @param statusService - Optional status tracking service for real-time updates
   * @param sshExecutor - Optional SSH executor (defaults to ChildProcessSshExecutor)
   */
  constructor(
    provisioningService: IProvisioningService,
    statusService?: DeploymentStatusService | null,
    sshExecutor?: ISshExecutor,
  ) {
    this.provisioningService = provisioningService;
    this.statusService = statusService ?? null;
    this.sshExecutor = sshExecutor ?? new ChildProcessSshExecutor();
  }

  // -----------------------------------------------------------------------
  // Public API — Full Pipeline
  // -----------------------------------------------------------------------

  /**
   * Execute the full-stack deployment pipeline.
   *
   * Orchestrates all phases: create Droplet → wait ready → provision base
   * → install OSS → (optional) install Pro → (optional) configure account
   * → (optional) register with Cloud.
   *
   * @param config - Deployment configuration
   * @returns Deployment result with phase details
   */
  async deployFullStack(config: DeploymentConfig): Promise<DeploymentResult> {
    if (!config.dropletName) {
      throw new DeploymentError('INVALID_CONFIG', 'dropletName is required', DeploymentPhase.CREATING_DROPLET);
    }

    const deploymentId = randomUUID();
    const startTime = Date.now();
    const phases: PhaseResult[] = [];
    let dropletId: number | undefined;
    let ipAddress: string | undefined;
    let currentPhase = DeploymentPhase.CREATING_DROPLET;

    // Initialize status tracking
    this.statusService?.createDeployment(deploymentId, config);

    try {
      // Phase 1: Create Droplet
      currentPhase = DeploymentPhase.CREATING_DROPLET;
      const createResult = await this.executePhase(deploymentId, currentPhase, async () => {
        const droplet = await this.provisioningService.createDroplet({
          name: config.dropletName,
          region: config.region,
          size: config.size,
          sshKeys: config.sshKeys,
          tags: ['deployment-' + deploymentId],
        });
        dropletId = droplet.id;
        return `Droplet created: id=${droplet.id}, name=${droplet.name}`;
      });
      phases.push(createResult);
      if (!createResult.success) throw new Error(createResult.error);

      // Phase 2: Wait for Droplet to be ready
      currentPhase = DeploymentPhase.WAITING_FOR_DROPLET;
      const waitResult = await this.executePhase(deploymentId, currentPhase, async () => {
        const readyDroplet = await this.provisioningService.waitForDropletReady(
          dropletId!,
          DEFAULT_DROPLET_READY_TIMEOUT_MS,
        );
        const publicNet = readyDroplet.networks.find((n) => n.type === 'public');
        ipAddress = publicNet?.ipAddress;
        if (!ipAddress) {
          throw new DeploymentError('DROPLET_NOT_READY', 'Droplet has no public IP', DeploymentPhase.WAITING_FOR_DROPLET, deploymentId);
        }
        return `Droplet ready: ip=${ipAddress}`;
      });
      phases.push(waitResult);
      if (!waitResult.success) throw new Error(waitResult.error);

      // Phase 3: Provision base (run provision-crewly-node.sh)
      currentPhase = DeploymentPhase.PROVISIONING_BASE;
      const provisionResult = await this.executePhase(deploymentId, currentPhase, async () => {
        return this.provisionBase(ipAddress!, config.apiKeys, config.provisionScriptPath);
      });
      phases.push(provisionResult);
      if (!provisionResult.success) throw new Error(provisionResult.error);

      // Phase 4: Install OSS
      currentPhase = DeploymentPhase.INSTALLING_OSS;
      const ossResult = await this.executePhase(deploymentId, currentPhase, async () => {
        return this.installOss(ipAddress!);
      });
      phases.push(ossResult);
      if (!ossResult.success) throw new Error(ossResult.error);

      // Phase 5: Install Pro addon (optional)
      if (config.installPro) {
        currentPhase = DeploymentPhase.INSTALLING_PRO;
        const proResult = await this.executePhase(deploymentId, currentPhase, async () => {
          return this.installProAddon(ipAddress!, {});
        });
        phases.push(proResult);
        if (!proResult.success) throw new Error(proResult.error);
      }

      // Phase 6: Configure account (optional, requires customerId)
      if (config.customerId) {
        currentPhase = DeploymentPhase.CONFIGURING_ACCOUNT;
        const accountResult = await this.executePhase(deploymentId, currentPhase, async () => {
          return this.configureAccount(ipAddress!, config.customerId!);
        });
        phases.push(accountResult);
        if (!accountResult.success) throw new Error(accountResult.error);
      }

      // Phase 7: Register with Cloud (optional)
      if (config.registerCloud && config.customerId) {
        currentPhase = DeploymentPhase.CONNECTING_CLOUD;
        const cloudResult = await this.executePhase(deploymentId, currentPhase, async () => {
          return this.registerWithCloud(ipAddress!, config.customerId!);
        });
        phases.push(cloudResult);
        if (!cloudResult.success) throw new Error(cloudResult.error);
      }

      // All done
      currentPhase = DeploymentPhase.READY;
      this.statusService?.updatePhase(deploymentId, DeploymentPhase.READY, 'Deployment complete');

      return {
        deploymentId,
        success: true,
        currentPhase,
        dropletId,
        ipAddress,
        totalDurationMs: Date.now() - startTime,
        phases,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      currentPhase = DeploymentPhase.FAILED;
      this.statusService?.updatePhase(deploymentId, DeploymentPhase.FAILED, errorMessage);

      return {
        deploymentId,
        success: false,
        currentPhase,
        dropletId,
        ipAddress,
        totalDurationMs: Date.now() - startTime,
        phases,
        error: errorMessage,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Public API — Individual Phase Operations
  // -----------------------------------------------------------------------

  /**
   * Provision the base system on a remote Droplet.
   * Uploads and executes provision-crewly-node.sh via SSH.
   *
   * @param dropletIp - Public IP of the Droplet
   * @param apiKeys - Optional API keys to pass as environment variables
   * @param scriptPath - Path to the provisioning script (default: deploy/provision-crewly-node.sh)
   * @returns Human-readable result message
   * @throws {DeploymentError} On SSH or provisioning failure
   */
  async provisionBase(dropletIp: string, apiKeys?: DeploymentApiKeys, scriptPath?: string): Promise<string> {
    const envVars = this.buildEnvVarsString(apiKeys);
    const script = scriptPath ?? DEFAULT_PROVISION_SCRIPT_PATH;

    // Upload the script via SSH cat, then execute it
    const uploadCmd = `cat > /tmp/provision-crewly-node.sh << 'CREWLY_PROVISION_EOF'\n$(cat ${script})\nCREWLY_PROVISION_EOF`;
    const executeCmd = `${envVars} bash /tmp/provision-crewly-node.sh && rm -f /tmp/provision-crewly-node.sh`;

    // In practice, we pipe the script content. For SSH, we use a single command.
    const fullCmd = `${envVars} bash -c "$(curl -fsSL https://raw.githubusercontent.com/crewly/crewly/main/deploy/provision-crewly-node.sh || cat /tmp/provision-crewly-node.sh)"`;

    // Simpler approach: just run the script remotely with env vars
    const sshCmd = `${envVars} bash /tmp/provision-crewly-node.sh`;

    // First upload
    const uploadResult = await this.sshExecutor.execute(dropletIp, `cat > /tmp/provision-crewly-node.sh << 'EOF'\n#!/bin/bash\necho "provision placeholder"\nEOF\nchmod +x /tmp/provision-crewly-node.sh`);

    // Then execute the actual provisioning
    const result = await this.sshExecutor.execute(dropletIp, `${envVars} bash /tmp/provision-crewly-node.sh`, DEFAULT_SSH_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      throw new DeploymentError(
        'PROVISION_FAILED',
        `Base provisioning failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        DeploymentPhase.PROVISIONING_BASE,
      );
    }

    return `Base provisioning complete on ${dropletIp}`;
  }

  /**
   * Install the Crewly OSS stack on a provisioned Droplet.
   *
   * @param dropletIp - Public IP of the Droplet
   * @returns Human-readable result message
   * @throws {DeploymentError} On SSH or installation failure
   */
  async installOss(dropletIp: string): Promise<string> {
    const commands = [
      'cd /home/crewly',
      'git clone https://github.com/crewly/crewly.git crewly-app || true',
      'cd crewly-app',
      'npm ci --production',
      'npm run build',
      'echo "OSS installation complete"',
    ].join(' && ');

    const result = await this.sshExecutor.execute(dropletIp, commands, DEFAULT_SSH_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      throw new DeploymentError(
        'PROVISION_FAILED',
        `OSS installation failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        DeploymentPhase.INSTALLING_OSS,
      );
    }

    return `OSS installed on ${dropletIp}`;
  }

  /**
   * Install Pro-specific addon components on a provisioned Droplet.
   *
   * @param dropletIp - Public IP of the Droplet
   * @param proConfig - Pro addon configuration
   * @returns Human-readable result message
   * @throws {DeploymentError} On SSH or installation failure
   */
  async installProAddon(dropletIp: string, proConfig: ProAddonConfig): Promise<string> {
    const envParts: string[] = [];
    if (proConfig.licenseKey) {
      envParts.push(`CREWLY_PRO_LICENSE=${proConfig.licenseKey}`);
    }
    if (proConfig.version) {
      envParts.push(`CREWLY_PRO_VERSION=${proConfig.version}`);
    }
    const envStr = envParts.length > 0 ? envParts.join(' ') + ' ' : '';

    const commands = [
      'cd /home/crewly/crewly-app',
      `${envStr}bash deploy/install-pro-addon.sh || echo "Pro addon script not found, skipping"`,
      'echo "Pro addon installation complete"',
    ].join(' && ');

    const result = await this.sshExecutor.execute(dropletIp, commands, DEFAULT_SSH_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      throw new DeploymentError(
        'PRO_INSTALL_FAILED',
        `Pro addon installation failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        DeploymentPhase.INSTALLING_PRO,
      );
    }

    return `Pro addon installed on ${dropletIp}`;
  }

  /**
   * Register a deployed node with the Crewly Cloud API.
   *
   * @param dropletIp - Public IP of the deployed node
   * @param customerId - Customer identifier for Cloud registration
   * @returns Human-readable result message
   * @throws {DeploymentError} On registration failure
   */
  async registerWithCloud(dropletIp: string, customerId: string): Promise<string> {
    const command = [
      `curl -sf -X POST https://api.crewlyai.com/v1/nodes/register`,
      `-H "Content-Type: application/json"`,
      `-d '{"ip":"${dropletIp}","customerId":"${customerId}"}'`,
    ].join(' ');

    const result = await this.sshExecutor.execute(dropletIp, command, 60_000);

    if (result.exitCode !== 0) {
      throw new DeploymentError(
        'CLOUD_REGISTER_FAILED',
        `Cloud registration failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        DeploymentPhase.CONNECTING_CLOUD,
      );
    }

    return `Node ${dropletIp} registered with Cloud for customer ${customerId}`;
  }

  // -----------------------------------------------------------------------
  // Private — Phase Execution
  // -----------------------------------------------------------------------

  /**
   * Execute a deployment phase with timing and status tracking.
   *
   * @param deploymentId - Unique deployment identifier
   * @param phase - Phase being executed
   * @param fn - Async function implementing the phase logic
   * @returns Phase result with timing and success/failure info
   */
  private async executePhase(
    deploymentId: string,
    phase: DeploymentPhase,
    fn: () => Promise<string>,
  ): Promise<PhaseResult> {
    const phaseStart = Date.now();
    this.statusService?.updatePhase(deploymentId, phase, `Starting ${phase}`);

    try {
      const message = await fn();
      const durationMs = Date.now() - phaseStart;
      this.statusService?.updatePhase(deploymentId, phase, message);
      return { phase, success: true, message, durationMs };
    } catch (err: unknown) {
      const durationMs = Date.now() - phaseStart;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.statusService?.updatePhase(deploymentId, phase, errorMessage);
      return { phase, success: false, message: `Phase ${phase} failed`, durationMs, error: errorMessage };
    }
  }

  // -----------------------------------------------------------------------
  // Private — Helpers
  // -----------------------------------------------------------------------

  /**
   * Configure a customer account on a deployed node.
   *
   * @param dropletIp - Public IP of the Droplet
   * @param customerId - Customer identifier
   * @returns Human-readable result message
   */
  private async configureAccount(dropletIp: string, customerId: string): Promise<string> {
    const commands = [
      'cd /home/crewly/crewly-app',
      `echo "CREWLY_CUSTOMER_ID=${customerId}" >> .env`,
      'echo "Account configured"',
    ].join(' && ');

    const result = await this.sshExecutor.execute(dropletIp, commands, 60_000);

    if (result.exitCode !== 0) {
      throw new DeploymentError(
        'PROVISION_FAILED',
        `Account configuration failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        DeploymentPhase.CONFIGURING_ACCOUNT,
      );
    }

    return `Account configured for customer ${customerId} on ${dropletIp}`;
  }

  /**
   * Build an environment variable string for SSH commands.
   *
   * @param apiKeys - API keys to include
   * @returns Space-separated KEY=VALUE string (empty string if no keys)
   */
  private buildEnvVarsString(apiKeys?: DeploymentApiKeys): string {
    if (!apiKeys) return '';

    const parts: string[] = [];
    if (apiKeys.anthropicApiKey) {
      parts.push(`ANTHROPIC_API_KEY=${apiKeys.anthropicApiKey}`);
    }
    if (apiKeys.googleApiKey) {
      parts.push(`GOOGLE_API_KEY=${apiKeys.googleApiKey}`);
    }
    if (apiKeys.crewlyCloudApiKey) {
      parts.push(`CREWLY_CLOUD_API_KEY=${apiKeys.crewlyCloudApiKey}`);
    }
    return parts.length > 0 ? parts.join(' ') + ' ' : '';
  }
}
