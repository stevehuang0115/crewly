/**
 * Tests for deployment orchestrator type definitions and type guards.
 *
 * @module services/provisioning/deployment-orchestrator.types.test
 */

import {
  DeploymentPhase,
  DeploymentError,
  DEPLOYMENT_PHASE_ORDER,
  isDeploymentPhase,
  isDeploymentError,
  isTerminalPhase,
} from './deployment-orchestrator.types.js';

describe('DeploymentPhase', () => {
  it('should have all expected phases', () => {
    expect(DeploymentPhase.CREATING_DROPLET).toBe('CREATING_DROPLET');
    expect(DeploymentPhase.WAITING_FOR_DROPLET).toBe('WAITING_FOR_DROPLET');
    expect(DeploymentPhase.PROVISIONING_BASE).toBe('PROVISIONING_BASE');
    expect(DeploymentPhase.INSTALLING_OSS).toBe('INSTALLING_OSS');
    expect(DeploymentPhase.INSTALLING_PRO).toBe('INSTALLING_PRO');
    expect(DeploymentPhase.CONFIGURING_ACCOUNT).toBe('CONFIGURING_ACCOUNT');
    expect(DeploymentPhase.CONNECTING_CLOUD).toBe('CONNECTING_CLOUD');
    expect(DeploymentPhase.READY).toBe('READY');
    expect(DeploymentPhase.FAILED).toBe('FAILED');
  });
});

describe('DEPLOYMENT_PHASE_ORDER', () => {
  it('should have phases in correct execution order', () => {
    expect(DEPLOYMENT_PHASE_ORDER[0]).toBe(DeploymentPhase.CREATING_DROPLET);
    expect(DEPLOYMENT_PHASE_ORDER[DEPLOYMENT_PHASE_ORDER.length - 1]).toBe(DeploymentPhase.READY);
  });

  it('should not include FAILED phase', () => {
    expect(DEPLOYMENT_PHASE_ORDER).not.toContain(DeploymentPhase.FAILED);
  });

  it('should have 8 phases in order', () => {
    expect(DEPLOYMENT_PHASE_ORDER).toHaveLength(8);
  });
});

describe('DeploymentError', () => {
  it('should create error with all properties', () => {
    const error = new DeploymentError('SSH_FAILED', 'Connection refused', DeploymentPhase.PROVISIONING_BASE, 'deploy-1');

    expect(error.name).toBe('DeploymentError');
    expect(error.code).toBe('SSH_FAILED');
    expect(error.message).toBe('Connection refused');
    expect(error.phase).toBe(DeploymentPhase.PROVISIONING_BASE);
    expect(error.deploymentId).toBe('deploy-1');
  });

  it('should create error without optional deploymentId', () => {
    const error = new DeploymentError('INVALID_CONFIG', 'Missing name', DeploymentPhase.CREATING_DROPLET);

    expect(error.deploymentId).toBeUndefined();
  });

  it('should be an instance of Error', () => {
    const error = new DeploymentError('UNKNOWN', 'test', DeploymentPhase.FAILED);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('isDeploymentPhase', () => {
  it('should return true for valid phases', () => {
    expect(isDeploymentPhase('CREATING_DROPLET')).toBe(true);
    expect(isDeploymentPhase('READY')).toBe(true);
    expect(isDeploymentPhase('FAILED')).toBe(true);
    expect(isDeploymentPhase('INSTALLING_PRO')).toBe(true);
  });

  it('should return false for invalid values', () => {
    expect(isDeploymentPhase('INVALID')).toBe(false);
    expect(isDeploymentPhase('')).toBe(false);
    expect(isDeploymentPhase(null)).toBe(false);
    expect(isDeploymentPhase(undefined)).toBe(false);
    expect(isDeploymentPhase(42)).toBe(false);
    expect(isDeploymentPhase({})).toBe(false);
  });
});

describe('isDeploymentError', () => {
  it('should return true for DeploymentError instances', () => {
    const error = new DeploymentError('SSH_FAILED', 'test', DeploymentPhase.FAILED);
    expect(isDeploymentError(error)).toBe(true);
  });

  it('should return false for plain Error', () => {
    expect(isDeploymentError(new Error('test'))).toBe(false);
  });

  it('should return false for non-error values', () => {
    expect(isDeploymentError(null)).toBe(false);
    expect(isDeploymentError('string')).toBe(false);
    expect(isDeploymentError({})).toBe(false);
  });
});

describe('isTerminalPhase', () => {
  it('should return true for READY', () => {
    expect(isTerminalPhase(DeploymentPhase.READY)).toBe(true);
  });

  it('should return true for FAILED', () => {
    expect(isTerminalPhase(DeploymentPhase.FAILED)).toBe(true);
  });

  it('should return false for non-terminal phases', () => {
    expect(isTerminalPhase(DeploymentPhase.CREATING_DROPLET)).toBe(false);
    expect(isTerminalPhase(DeploymentPhase.PROVISIONING_BASE)).toBe(false);
    expect(isTerminalPhase(DeploymentPhase.INSTALLING_OSS)).toBe(false);
    expect(isTerminalPhase(DeploymentPhase.CONNECTING_CLOUD)).toBe(false);
  });
});
