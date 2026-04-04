/**
 * Provisioning Controller
 *
 * Express route handlers for the deployment provisioning API.
 * Provides endpoints for triggering deployments, checking status,
 * and listing deployment history.
 *
 * @module controllers/provisioning/provisioning.controller
 */

import type { Request, Response } from 'express';

import { DeploymentStatusService } from '../../services/provisioning/deployment-status.service.js';
import { DeploymentOrchestratorService } from '../../services/provisioning/deployment-orchestrator.service.js';
import { ProvisioningService } from '../../services/provisioning/provisioning.service.js';
import { DeploymentPhase, type DeploymentConfig } from '../../services/provisioning/deployment-orchestrator.types.js';

// ---------------------------------------------------------------------------
// Singleton Services (lazy-initialized)
// ---------------------------------------------------------------------------

let statusService: DeploymentStatusService | null = null;
let orchestratorService: DeploymentOrchestratorService | null = null;

/**
 * Get or create the DeploymentStatusService singleton.
 *
 * @returns DeploymentStatusService instance
 */
export function getStatusService(): DeploymentStatusService {
  if (!statusService) {
    statusService = new DeploymentStatusService();
  }
  return statusService;
}

/**
 * Get or create the DeploymentOrchestratorService singleton.
 * Requires DO_API_TOKEN environment variable.
 *
 * @returns DeploymentOrchestratorService instance, or null if not configured
 */
function getOrchestratorService(): DeploymentOrchestratorService | null {
  if (orchestratorService) return orchestratorService;

  const apiToken = process.env['DO_API_TOKEN'];
  if (!apiToken) return null;

  const provisioningService = new ProvisioningService({ apiToken });
  orchestratorService = new DeploymentOrchestratorService(provisioningService, getStatusService());
  return orchestratorService;
}

/**
 * Override singleton services (for testing).
 *
 * @param overrides - Service overrides
 */
export function setProvisioningServices(overrides: {
  statusService?: DeploymentStatusService;
  orchestratorService?: DeploymentOrchestratorService;
}): void {
  if (overrides.statusService) statusService = overrides.statusService;
  if (overrides.orchestratorService) orchestratorService = overrides.orchestratorService;
}

/**
 * Reset singleton services (for testing).
 */
export function resetProvisioningServices(): void {
  statusService = null;
  orchestratorService = null;
}

// ---------------------------------------------------------------------------
// Request/Response Types
// ---------------------------------------------------------------------------

/** Request body for POST /api/provisioning/deployments */
export interface CreateDeploymentRequestBody {
  dropletName: string;
  region?: string;
  size?: string;
  sshKeys?: (number | string)[];
  apiKeys?: {
    anthropicApiKey?: string;
    googleApiKey?: string;
    crewlyCloudApiKey?: string;
  };
  customerId?: string;
  installPro?: boolean;
  registerCloud?: boolean;
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/provisioning/deployments
 *
 * Trigger a new full-stack deployment. Returns immediately with
 * a deploymentId; the deployment runs asynchronously.
 *
 * @param req - Express request with CreateDeploymentRequestBody
 * @param res - Express response
 */
export async function createDeployment(req: Request, res: Response): Promise<void> {
  const orchestrator = getOrchestratorService();
  if (!orchestrator) {
    res.status(503).json({
      error: 'Provisioning not configured',
      message: 'DO_API_TOKEN environment variable is not set',
    });
    return;
  }

  const body = req.body as CreateDeploymentRequestBody;

  if (!body.dropletName || typeof body.dropletName !== 'string') {
    res.status(400).json({
      error: 'Invalid request',
      message: 'dropletName is required and must be a string',
    });
    return;
  }

  const config: DeploymentConfig = {
    dropletName: body.dropletName,
    region: body.region,
    size: body.size,
    sshKeys: body.sshKeys,
    apiKeys: body.apiKeys,
    customerId: body.customerId,
    installPro: body.installPro ?? false,
    registerCloud: body.registerCloud ?? false,
  };

  // Start deployment asynchronously
  const svc = getStatusService();
  const deploymentId = crypto.randomUUID();
  svc.createDeployment(deploymentId, config);

  // Run deployment in background (don't await)
  orchestrator.deployFullStack(config).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    svc.updatePhase(deploymentId, DeploymentPhase.FAILED, msg);
  });

  res.status(202).json({
    deploymentId,
    message: 'Deployment initiated',
    statusUrl: `/api/provisioning/deployments/${deploymentId}/status`,
  });
}

/**
 * GET /api/provisioning/deployments/:id/status
 *
 * Get the current status of a deployment.
 *
 * @param req - Express request with id param
 * @param res - Express response
 */
export function getDeploymentStatus(req: Request, res: Response): void {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: 'Missing deployment ID' });
    return;
  }

  const svc = getStatusService();
  const status = svc.getDeploymentStatus(id);

  if (!status) {
    res.status(404).json({
      error: 'Deployment not found',
      message: `No deployment with ID ${id}`,
    });
    return;
  }

  res.json(status);
}

/**
 * GET /api/provisioning/deployments
 *
 * List all tracked deployments with optional filters.
 *
 * @param req - Express request with optional query params
 * @param res - Express response
 */
export function listDeployments(req: Request, res: Response): void {
  const svc = getStatusService();
  const { complete, customerId } = req.query;

  const filter: { isComplete?: boolean; customerId?: string } = {};
  if (complete === 'true') filter.isComplete = true;
  if (complete === 'false') filter.isComplete = false;
  if (typeof customerId === 'string') filter.customerId = customerId;

  const deployments = svc.listDeployments(filter);
  res.json({ deployments, total: deployments.length });
}

/**
 * DELETE /api/provisioning/deployments/:id
 *
 * Remove a deployment record from the in-memory store.
 *
 * @param req - Express request with id param
 * @param res - Express response
 */
export function removeDeployment(req: Request, res: Response): void {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: 'Missing deployment ID' });
    return;
  }

  const svc = getStatusService();
  const removed = svc.removeDeployment(id);

  if (!removed) {
    res.status(404).json({
      error: 'Deployment not found',
      message: `No deployment with ID ${id}`,
    });
    return;
  }

  res.status(204).send();
}
