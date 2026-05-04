/**
 * Teams Backup Routes Tests
 *
 * @module controllers/teams-backup/teams-backup.routes.test
 */

import { Router } from 'express';
import { createTeamsBackupRouter } from './teams-backup.routes.js';

describe('Teams Backup Routes', () => {
  let router: Router;

  beforeEach(() => {
    router = createTeamsBackupRouter();
  });

  it('should create a router instance', () => {
    expect(router).toBeDefined();
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThan(0);
  });

  it('should have GET route for /status', () => {
    const route = router.stack.find(
      (layer: any) => layer.route?.path === '/status' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /restore', () => {
    const route = router.stack.find(
      (layer: any) => layer.route?.path === '/restore' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should have GET route for /history (A2 rotating snapshots)', () => {
    const route = router.stack.find(
      (layer: any) => layer.route?.path === '/history' && layer.route?.methods?.get
    );
    expect(route).toBeDefined();
  });

  it('should have POST route for /restore/:slot (A2 rotating snapshots)', () => {
    const route = router.stack.find(
      (layer: any) => layer.route?.path === '/restore/:slot' && layer.route?.methods?.post
    );
    expect(route).toBeDefined();
  });

  it('should register exactly 4 routes', () => {
    const routes = router.stack.filter((layer: any) => layer.route);
    expect(routes).toHaveLength(4);
  });
});
