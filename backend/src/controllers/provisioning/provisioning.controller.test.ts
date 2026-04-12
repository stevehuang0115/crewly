/**
 * Tests for the Provisioning Controller.
 *
 * Tests Express route handlers for deployment API endpoints.
 *
 * @module controllers/provisioning/provisioning.controller.test
 */

import type { Request, Response } from 'express';

import {
  createDeployment,
  getDeploymentStatus,
  listDeployments,
  removeDeployment,
  setProvisioningServices,
  resetProvisioningServices,
  getStatusService,
} from './provisioning.controller.js';
import { DeploymentStatusService } from '../../services/provisioning/deployment-status.service.js';
import { DeploymentPhase } from '../../services/provisioning/deployment-orchestrator.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Express Request. */
function mockRequest(overrides?: Partial<Request>): Request {
  return {
    body: {},
    params: {},
    query: {},
    ...overrides,
  } as Request;
}

/** Create a mock Express Response with jest spies. */
function mockResponse(): Response & { _status: number; _json: unknown; _sent: boolean } {
  const res = {
    _status: 200,
    _json: null as unknown,
    _sent: false,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
    send() {
      res._sent = true;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown; _sent: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Provisioning Controller', () => {
  let statusService: DeploymentStatusService;

  beforeEach(() => {
    resetProvisioningServices();
    statusService = new DeploymentStatusService();
    setProvisioningServices({ statusService });
  });

  afterEach(() => {
    statusService.removeAllListeners();
    resetProvisioningServices();
  });

  // -----------------------------------------------------------------------
  // createDeployment
  // -----------------------------------------------------------------------

  describe('createDeployment', () => {
    it('should return 503 when orchestrator is not configured', async () => {
      const req = mockRequest({ body: { dropletName: 'test' } });
      const res = mockResponse();

      await createDeployment(req, res);

      expect(res._status).toBe(503);
      expect((res._json as Record<string, string>).error).toContain('not configured');
    });

    it('should return 400 when dropletName is missing', async () => {
      // Set up a mock orchestrator
      const mockOrchestrator = {
        deployFullStack: jest.fn().mockResolvedValue({ success: true }),
      };
      setProvisioningServices({
        orchestratorService: mockOrchestrator as never,
      });

      const req = mockRequest({ body: {} });
      const res = mockResponse();

      await createDeployment(req, res);

      expect(res._status).toBe(400);
      expect((res._json as Record<string, string>).error).toContain('Invalid');
    });

    it('should return 202 with deploymentId when valid', async () => {
      const mockOrchestrator = {
        deployFullStack: jest.fn().mockResolvedValue({ success: true }),
      };
      setProvisioningServices({
        orchestratorService: mockOrchestrator as never,
      });

      const req = mockRequest({ body: { dropletName: 'my-node' } });
      const res = mockResponse();

      await createDeployment(req, res);

      expect(res._status).toBe(202);
      const json = res._json as Record<string, string>;
      expect(json.deploymentId).toBeDefined();
      expect(json.message).toContain('initiated');
      expect(json.statusUrl).toContain('/status');
    });
  });

  // -----------------------------------------------------------------------
  // getDeploymentStatus
  // -----------------------------------------------------------------------

  describe('getDeploymentStatus', () => {
    it('should return deployment status when found', () => {
      statusService.createDeployment('deploy-1', { dropletName: 'node-1' });

      const req = mockRequest({ params: { id: 'deploy-1' } });
      const res = mockResponse();

      getDeploymentStatus(req, res);

      expect(res._status).toBe(200);
      const json = res._json as Record<string, unknown>;
      expect(json.deploymentId).toBe('deploy-1');
      expect(json.currentPhase).toBe(DeploymentPhase.CREATING_DROPLET);
    });

    it('should return 404 for unknown deployment', () => {
      const req = mockRequest({ params: { id: 'unknown' } });
      const res = mockResponse();

      getDeploymentStatus(req, res);

      expect(res._status).toBe(404);
    });

    it('should return 400 when id param is missing', () => {
      const req = mockRequest({ params: {} });
      const res = mockResponse();

      getDeploymentStatus(req, res);

      expect(res._status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // listDeployments
  // -----------------------------------------------------------------------

  describe('listDeployments', () => {
    it('should return all deployments', () => {
      statusService.createDeployment('d1', { dropletName: 'n1' });
      statusService.createDeployment('d2', { dropletName: 'n2' });

      const req = mockRequest({ query: {} });
      const res = mockResponse();

      listDeployments(req, res);

      expect(res._status).toBe(200);
      const json = res._json as { deployments: unknown[]; total: number };
      expect(json.total).toBe(2);
      expect(json.deployments).toHaveLength(2);
    });

    it('should filter by complete=true', () => {
      statusService.createDeployment('d1', { dropletName: 'n1' });
      statusService.createDeployment('d2', { dropletName: 'n2' });
      statusService.updatePhase('d1', DeploymentPhase.READY, 'done');

      const req = mockRequest({ query: { complete: 'true' } });
      const res = mockResponse();

      listDeployments(req, res);

      const json = res._json as { deployments: unknown[]; total: number };
      expect(json.total).toBe(1);
    });

    it('should filter by customerId', () => {
      statusService.createDeployment('d1', { dropletName: 'n1', customerId: 'c1' });
      statusService.createDeployment('d2', { dropletName: 'n2', customerId: 'c2' });

      const req = mockRequest({ query: { customerId: 'c1' } });
      const res = mockResponse();

      listDeployments(req, res);

      const json = res._json as { deployments: unknown[]; total: number };
      expect(json.total).toBe(1);
    });

    it('should return empty list when no deployments', () => {
      const req = mockRequest({ query: {} });
      const res = mockResponse();

      listDeployments(req, res);

      const json = res._json as { deployments: unknown[]; total: number };
      expect(json.total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // removeDeployment
  // -----------------------------------------------------------------------

  describe('removeDeployment', () => {
    it('should remove deployment and return 204', () => {
      statusService.createDeployment('d1', { dropletName: 'n1' });

      const req = mockRequest({ params: { id: 'd1' } });
      const res = mockResponse();

      removeDeployment(req, res);

      expect(res._status).toBe(204);
      expect(res._sent).toBe(true);
      expect(statusService.getDeploymentStatus('d1')).toBeUndefined();
    });

    it('should return 404 for unknown deployment', () => {
      const req = mockRequest({ params: { id: 'unknown' } });
      const res = mockResponse();

      removeDeployment(req, res);

      expect(res._status).toBe(404);
    });

    it('should return 400 when id param is missing', () => {
      const req = mockRequest({ params: {} });
      const res = mockResponse();

      removeDeployment(req, res);

      expect(res._status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Service Management
  // -----------------------------------------------------------------------

  describe('getStatusService', () => {
    it('should return a singleton DeploymentStatusService', () => {
      resetProvisioningServices();
      const svc1 = getStatusService();
      const svc2 = getStatusService();
      expect(svc1).toBe(svc2);
    });
  });

  describe('resetProvisioningServices', () => {
    it('should clear singleton services', () => {
      const svc1 = getStatusService();
      resetProvisioningServices();
      const svc2 = getStatusService();
      expect(svc1).not.toBe(svc2);
    });
  });
});
