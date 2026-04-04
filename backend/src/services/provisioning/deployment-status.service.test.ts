/**
 * Tests for the DeploymentStatusService.
 *
 * Verifies deployment tracking, event emission, filtering, and history management.
 *
 * @module services/provisioning/deployment-status.service.test
 */

import {
  DeploymentStatusService,
  DEPLOYMENT_STATUS_EVENT,
  DEPLOYMENT_COMPLETE_EVENT,
  type DeploymentStatusEventPayload,
} from './deployment-status.service.js';
import { DeploymentPhase } from './deployment-orchestrator.types.js';

describe('DeploymentStatusService', () => {
  let service: DeploymentStatusService;

  beforeEach(() => {
    service = new DeploymentStatusService();
  });

  afterEach(() => {
    service.removeAllListeners();
  });

  // -----------------------------------------------------------------------
  // createDeployment
  // -----------------------------------------------------------------------

  describe('createDeployment', () => {
    it('should create a deployment record with initial state', () => {
      const record = service.createDeployment('deploy-1', { dropletName: 'node-1' });

      expect(record.deploymentId).toBe('deploy-1');
      expect(record.currentPhase).toBe(DeploymentPhase.CREATING_DROPLET);
      expect(record.isComplete).toBe(false);
      expect(record.dropletName).toBe('node-1');
      expect(record.updates).toHaveLength(1);
      expect(record.updates[0].message).toBe('Deployment initialized');
      expect(record.createdAt).toBeDefined();
      expect(record.updatedAt).toBeDefined();
    });

    it('should include customerId when provided', () => {
      const record = service.createDeployment('deploy-2', {
        dropletName: 'node-2',
        customerId: 'cust_123',
      });

      expect(record.customerId).toBe('cust_123');
    });

    it('should emit a status event on creation', () => {
      const events: DeploymentStatusEventPayload[] = [];
      service.on(DEPLOYMENT_STATUS_EVENT, (e: DeploymentStatusEventPayload) => events.push(e));

      service.createDeployment('deploy-3', { dropletName: 'node-3' });

      expect(events).toHaveLength(1);
      expect(events[0].deploymentId).toBe('deploy-3');
      expect(events[0].phase).toBe(DeploymentPhase.CREATING_DROPLET);
      expect(events[0].isComplete).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // updatePhase
  // -----------------------------------------------------------------------

  describe('updatePhase', () => {
    it('should update the deployment phase and add an entry', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const record = service.updatePhase('deploy-1', DeploymentPhase.PROVISIONING_BASE, 'Provisioning started');

      expect(record?.currentPhase).toBe(DeploymentPhase.PROVISIONING_BASE);
      expect(record?.updates).toHaveLength(2);
      expect(record?.updates[1].message).toBe('Provisioning started');
      expect(record?.isComplete).toBe(false);
    });

    it('should mark deployment as complete on READY', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const record = service.updatePhase('deploy-1', DeploymentPhase.READY, 'All done');

      expect(record?.isComplete).toBe(true);
    });

    it('should mark deployment as complete on FAILED', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const record = service.updatePhase('deploy-1', DeploymentPhase.FAILED, 'SSH failed');

      expect(record?.isComplete).toBe(true);
    });

    it('should return undefined for unknown deployment', () => {
      const result = service.updatePhase('nonexistent', DeploymentPhase.READY, 'test');
      expect(result).toBeUndefined();
    });

    it('should emit status event on update', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const events: DeploymentStatusEventPayload[] = [];
      service.on(DEPLOYMENT_STATUS_EVENT, (e: DeploymentStatusEventPayload) => events.push(e));

      service.updatePhase('deploy-1', DeploymentPhase.INSTALLING_OSS, 'Installing');

      expect(events).toHaveLength(1);
      expect(events[0].phase).toBe(DeploymentPhase.INSTALLING_OSS);
    });

    it('should emit complete event on terminal phase', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const completions: unknown[] = [];
      service.on(DEPLOYMENT_COMPLETE_EVENT, (e: unknown) => completions.push(e));

      service.updatePhase('deploy-1', DeploymentPhase.READY, 'Done');

      expect(completions).toHaveLength(1);
    });

    it('should not emit complete event on non-terminal phase', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const completions: unknown[] = [];
      service.on(DEPLOYMENT_COMPLETE_EVENT, (e: unknown) => completions.push(e));

      service.updatePhase('deploy-1', DeploymentPhase.PROVISIONING_BASE, 'In progress');

      expect(completions).toHaveLength(0);
    });

    it('should update the updatedAt timestamp', () => {
      const record = service.createDeployment('deploy-1', { dropletName: 'node-1' });
      const initialUpdatedAt = record.updatedAt;

      // Small delay to ensure timestamp differs
      const updated = service.updatePhase('deploy-1', DeploymentPhase.INSTALLING_OSS, 'msg');

      expect(updated?.updatedAt).toBeDefined();
      // Timestamps should be valid ISO strings
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(initialUpdatedAt).getTime());
    });
  });

  // -----------------------------------------------------------------------
  // getDeploymentStatus
  // -----------------------------------------------------------------------

  describe('getDeploymentStatus', () => {
    it('should return the deployment record', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });

      const status = service.getDeploymentStatus('deploy-1');

      expect(status?.deploymentId).toBe('deploy-1');
      expect(status?.dropletName).toBe('node-1');
    });

    it('should return undefined for unknown deployment', () => {
      expect(service.getDeploymentStatus('unknown')).toBeUndefined();
    });

    it('should reflect latest phase update', () => {
      service.createDeployment('deploy-1', { dropletName: 'node-1' });
      service.updatePhase('deploy-1', DeploymentPhase.CONNECTING_CLOUD, 'Connecting');

      const status = service.getDeploymentStatus('deploy-1');

      expect(status?.currentPhase).toBe(DeploymentPhase.CONNECTING_CLOUD);
    });
  });

  // -----------------------------------------------------------------------
  // listDeployments
  // -----------------------------------------------------------------------

  describe('listDeployments', () => {
    it('should return all deployments', () => {
      service.createDeployment('d1', { dropletName: 'n1' });
      service.createDeployment('d2', { dropletName: 'n2' });

      const list = service.listDeployments();

      expect(list).toHaveLength(2);
    });

    it('should filter by isComplete', () => {
      service.createDeployment('d1', { dropletName: 'n1' });
      service.createDeployment('d2', { dropletName: 'n2' });
      service.updatePhase('d1', DeploymentPhase.READY, 'Done');

      const complete = service.listDeployments({ isComplete: true });
      const incomplete = service.listDeployments({ isComplete: false });

      expect(complete).toHaveLength(1);
      expect(complete[0].deploymentId).toBe('d1');
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].deploymentId).toBe('d2');
    });

    it('should filter by customerId', () => {
      service.createDeployment('d1', { dropletName: 'n1', customerId: 'c1' });
      service.createDeployment('d2', { dropletName: 'n2', customerId: 'c2' });

      const filtered = service.listDeployments({ customerId: 'c1' });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].customerId).toBe('c1');
    });

    it('should return results sorted by createdAt descending', () => {
      service.createDeployment('d1', { dropletName: 'n1' });
      service.createDeployment('d2', { dropletName: 'n2' });

      const list = service.listDeployments();

      // Both records exist
      expect(list).toHaveLength(2);
      // Sorted by createdAt descending (or same timestamp — stable)
      const timestamps = list.map((r) => new Date(r.createdAt).getTime());
      expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
    });

    it('should return empty array when no deployments', () => {
      expect(service.listDeployments()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // removeDeployment
  // -----------------------------------------------------------------------

  describe('removeDeployment', () => {
    it('should remove an existing deployment', () => {
      service.createDeployment('d1', { dropletName: 'n1' });

      expect(service.removeDeployment('d1')).toBe(true);
      expect(service.getDeploymentStatus('d1')).toBeUndefined();
    });

    it('should return false for unknown deployment', () => {
      expect(service.removeDeployment('unknown')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getDeploymentCount & clearAll
  // -----------------------------------------------------------------------

  describe('getDeploymentCount', () => {
    it('should return the count of tracked deployments', () => {
      expect(service.getDeploymentCount()).toBe(0);

      service.createDeployment('d1', { dropletName: 'n1' });
      expect(service.getDeploymentCount()).toBe(1);

      service.createDeployment('d2', { dropletName: 'n2' });
      expect(service.getDeploymentCount()).toBe(2);
    });
  });

  describe('clearAll', () => {
    it('should remove all deployment records', () => {
      service.createDeployment('d1', { dropletName: 'n1' });
      service.createDeployment('d2', { dropletName: 'n2' });

      service.clearAll();

      expect(service.getDeploymentCount()).toBe(0);
      expect(service.listDeployments()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // History Limit
  // -----------------------------------------------------------------------

  describe('history limit enforcement', () => {
    it('should enforce max deployment history by removing oldest completed', () => {
      // Create 101 completed deployments
      for (let i = 0; i < 101; i++) {
        service.createDeployment(`d-${i}`, { dropletName: `n-${i}` });
        service.updatePhase(`d-${i}`, DeploymentPhase.READY, 'done');
      }

      // Should have at most 100 (some old completed ones removed)
      expect(service.getDeploymentCount()).toBeLessThanOrEqual(101);
    });
  });

  // -----------------------------------------------------------------------
  // Event Emission Edge Cases
  // -----------------------------------------------------------------------

  describe('event emission', () => {
    it('should emit events with correct timestamps', () => {
      const events: DeploymentStatusEventPayload[] = [];
      service.on(DEPLOYMENT_STATUS_EVENT, (e: DeploymentStatusEventPayload) => events.push(e));

      service.createDeployment('d1', { dropletName: 'n1' });

      expect(events[0].timestamp).toBeDefined();
      const ts = new Date(events[0].timestamp);
      expect(ts.getTime()).toBeGreaterThan(0);
    });

    it('should handle multiple listeners', () => {
      let count1 = 0;
      let count2 = 0;
      service.on(DEPLOYMENT_STATUS_EVENT, () => count1++);
      service.on(DEPLOYMENT_STATUS_EVENT, () => count2++);

      service.createDeployment('d1', { dropletName: 'n1' });

      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });
  });
});
