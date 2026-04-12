/**
 * Tests for the DeploymentOrchestratorService.
 *
 * Uses mock dependencies (IProvisioningService, ISshExecutor, DeploymentStatusService)
 * to test the orchestration logic without real infrastructure.
 *
 * @module services/provisioning/deployment-orchestrator.service.test
 */

import { DeploymentOrchestratorService } from './deployment-orchestrator.service.js';
import { DeploymentStatusService } from './deployment-status.service.js';
import {
  DeploymentPhase,
  DeploymentError,
  type ISshExecutor,
  type IProvisioningService,
  type SshCommandResult,
} from './deployment-orchestrator.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock ProvisioningService. */
function createMockProvisioning(overrides?: Partial<IProvisioningService>): IProvisioningService {
  return {
    createDroplet: jest.fn().mockResolvedValue({
      id: 12345,
      name: 'test-node',
      status: 'new',
      networks: [],
    }),
    waitForDropletReady: jest.fn().mockResolvedValue({
      id: 12345,
      name: 'test-node',
      status: 'active',
      networks: [{ ipAddress: '10.0.0.1', type: 'public' }],
    }),
    ...overrides,
  };
}

/** Create a mock SSH executor. */
function createMockSsh(result?: Partial<SshCommandResult>): ISshExecutor {
  return {
    execute: jest.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      ...result,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeploymentOrchestratorService', () => {
  let provisioning: IProvisioningService;
  let ssh: ISshExecutor;
  let statusService: DeploymentStatusService;
  let orchestrator: DeploymentOrchestratorService;

  beforeEach(() => {
    provisioning = createMockProvisioning();
    ssh = createMockSsh();
    statusService = new DeploymentStatusService();
    orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);
  });

  afterEach(() => {
    statusService.removeAllListeners();
  });

  // -----------------------------------------------------------------------
  // deployFullStack — Happy Path
  // -----------------------------------------------------------------------

  describe('deployFullStack', () => {
    it('should complete a minimal deployment (no Pro, no Cloud)', async () => {
      const result = await orchestrator.deployFullStack({
        dropletName: 'test-node',
      });

      expect(result.success).toBe(true);
      expect(result.currentPhase).toBe(DeploymentPhase.READY);
      expect(result.dropletId).toBe(12345);
      expect(result.ipAddress).toBe('10.0.0.1');
      expect(result.deploymentId).toBeDefined();
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.phases.length).toBeGreaterThanOrEqual(4);

      // Verify each phase succeeded
      for (const phase of result.phases) {
        expect(phase.success).toBe(true);
        expect(phase.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('should execute all phases when Pro and Cloud are enabled', async () => {
      const result = await orchestrator.deployFullStack({
        dropletName: 'full-node',
        customerId: 'cust_123',
        installPro: true,
        registerCloud: true,
        apiKeys: {
          anthropicApiKey: 'sk-test',
          googleApiKey: 'gk-test',
        },
      });

      expect(result.success).toBe(true);
      expect(result.phases.length).toBe(7); // create + wait + provision + oss + pro + account + cloud
    });

    it('should call ProvisioningService.createDroplet with correct params', async () => {
      await orchestrator.deployFullStack({
        dropletName: 'my-node',
        region: 'sfo3',
        size: 's-4vcpu-8gb',
        sshKeys: [123],
      });

      expect(provisioning.createDroplet).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-node',
          region: 'sfo3',
          size: 's-4vcpu-8gb',
          sshKeys: [123],
        }),
      );
    });

    it('should call waitForDropletReady with the created Droplet ID', async () => {
      await orchestrator.deployFullStack({ dropletName: 'test' });

      expect(provisioning.waitForDropletReady).toHaveBeenCalledWith(12345, 300_000);
    });

    it('should SSH to the correct IP', async () => {
      await orchestrator.deployFullStack({ dropletName: 'test' });

      // SSH should have been called with the IP from waitForDropletReady
      expect(ssh.execute).toHaveBeenCalled();
      const calls = (ssh.execute as jest.Mock).mock.calls;
      // At least one call should target the IP
      const ips = calls.map((c: string[]) => c[0]);
      expect(ips).toContain('10.0.0.1');
    });

    it('should track deployment via statusService', async () => {
      const events: unknown[] = [];
      statusService.on('deployment:status', (e: unknown) => events.push(e));

      await orchestrator.deployFullStack({ dropletName: 'tracked-node' });

      expect(events.length).toBeGreaterThanOrEqual(4);
    });
  });

  // -----------------------------------------------------------------------
  // deployFullStack — Error Handling
  // -----------------------------------------------------------------------

  describe('deployFullStack — error handling', () => {
    it('should throw on missing dropletName', async () => {
      await expect(
        orchestrator.deployFullStack({ dropletName: '' }),
      ).rejects.toThrow(DeploymentError);
    });

    it('should return failure when Droplet creation fails', async () => {
      provisioning = createMockProvisioning({
        createDroplet: jest.fn().mockRejectedValue(new Error('Rate limited')),
      });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      const result = await orchestrator.deployFullStack({ dropletName: 'fail-node' });

      expect(result.success).toBe(false);
      expect(result.currentPhase).toBe(DeploymentPhase.FAILED);
      expect(result.error).toContain('Rate limited');
      expect(result.phases[0].success).toBe(false);
    });

    it('should return failure when Droplet never becomes ready', async () => {
      provisioning = createMockProvisioning({
        waitForDropletReady: jest.fn().mockRejectedValue(new Error('Timeout')),
      });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      const result = await orchestrator.deployFullStack({ dropletName: 'timeout-node' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
      expect(result.dropletId).toBe(12345);
    });

    it('should return failure when Droplet has no public IP', async () => {
      provisioning = createMockProvisioning({
        waitForDropletReady: jest.fn().mockResolvedValue({
          id: 12345,
          name: 'no-ip',
          status: 'active',
          networks: [{ ipAddress: '10.0.0.2', type: 'private' }],
        }),
      });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      const result = await orchestrator.deployFullStack({ dropletName: 'no-ip-node' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('public IP');
    });

    it('should return failure when SSH provisioning fails', async () => {
      ssh = createMockSsh({ exitCode: 1, stderr: 'permission denied' });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      const result = await orchestrator.deployFullStack({ dropletName: 'ssh-fail' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('provisioning failed');
    });

    it('should set dropletId even when later phases fail', async () => {
      ssh = createMockSsh({ exitCode: 1, stderr: 'script error' });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      const result = await orchestrator.deployFullStack({ dropletName: 'partial' });

      expect(result.dropletId).toBe(12345);
      expect(result.ipAddress).toBe('10.0.0.1');
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Individual Phase Methods
  // -----------------------------------------------------------------------

  describe('provisionBase', () => {
    it('should execute SSH command with API keys as env vars', async () => {
      await orchestrator.provisionBase('10.0.0.1', {
        anthropicApiKey: 'sk-test',
        googleApiKey: 'gk-test',
        crewlyCloudApiKey: 'ck-test',
      });

      const calls = (ssh.execute as jest.Mock).mock.calls;
      // At least one SSH call should contain ANTHROPIC_API_KEY
      const hasEnvVars = calls.some((c: string[]) => c[1].includes('ANTHROPIC_API_KEY'));
      expect(hasEnvVars).toBe(true);
    });

    it('should throw DeploymentError on non-zero exit code', async () => {
      ssh = createMockSsh({ exitCode: 1, stderr: 'apt-get failed' });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      await expect(orchestrator.provisionBase('10.0.0.1')).rejects.toThrow(DeploymentError);
    });

    it('should succeed with no API keys', async () => {
      const result = await orchestrator.provisionBase('10.0.0.1');
      expect(result).toContain('10.0.0.1');
    });
  });

  describe('installOss', () => {
    it('should run git clone and npm commands', async () => {
      await orchestrator.installOss('10.0.0.1');

      const calls = (ssh.execute as jest.Mock).mock.calls;
      const cmd = calls.find((c: string[]) => c[1].includes('git clone'));
      expect(cmd).toBeDefined();
    });

    it('should throw on failure', async () => {
      ssh = createMockSsh({ exitCode: 1, stderr: 'npm failed' });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      await expect(orchestrator.installOss('10.0.0.1')).rejects.toThrow(DeploymentError);
    });
  });

  describe('installProAddon', () => {
    it('should include license key in env vars when provided', async () => {
      await orchestrator.installProAddon('10.0.0.1', { licenseKey: 'pro-123' });

      const calls = (ssh.execute as jest.Mock).mock.calls;
      const hasLicense = calls.some((c: string[]) => c[1].includes('CREWLY_PRO_LICENSE=pro-123'));
      expect(hasLicense).toBe(true);
    });

    it('should succeed without config', async () => {
      const result = await orchestrator.installProAddon('10.0.0.1', {});
      expect(result).toContain('10.0.0.1');
    });

    it('should throw on failure', async () => {
      ssh = createMockSsh({ exitCode: 1, stderr: 'failed' });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      await expect(orchestrator.installProAddon('10.0.0.1', {})).rejects.toThrow(DeploymentError);
    });
  });

  describe('registerWithCloud', () => {
    it('should call Cloud API with IP and customerId', async () => {
      await orchestrator.registerWithCloud('10.0.0.1', 'cust_456');

      const calls = (ssh.execute as jest.Mock).mock.calls;
      const hasRegister = calls.some((c: string[]) =>
        c[1].includes('crewlyai.com') && c[1].includes('cust_456'),
      );
      expect(hasRegister).toBe(true);
    });

    it('should throw on failure', async () => {
      ssh = createMockSsh({ exitCode: 1, stderr: '503 unavailable' });
      orchestrator = new DeploymentOrchestratorService(provisioning, statusService, ssh);

      await expect(orchestrator.registerWithCloud('10.0.0.1', 'cust_123')).rejects.toThrow(DeploymentError);
    });
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should work without statusService', async () => {
      const orch = new DeploymentOrchestratorService(provisioning, null, ssh);
      const result = await orch.deployFullStack({ dropletName: 'no-status' });
      expect(result.success).toBe(true);
    });

    it('should work without ssh executor (uses default)', () => {
      // Should not throw
      const orch = new DeploymentOrchestratorService(provisioning, statusService);
      expect(orch).toBeDefined();
    });
  });
});
