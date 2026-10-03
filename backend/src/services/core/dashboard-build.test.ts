/**
 * Tests for the served-dashboard-build stamp (#1010 review).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { dashboardBuildHeader, dashboardBuildMessage, loadDashboardEntry, parseDashboardEntry } from './dashboard-build.js';

const BUILT = '<!doctype html><head><script type="module" crossorigin src="/assets/index-b91a9801.js"></script><link rel="stylesheet" href="/assets/index-1.css"></head>';

describe('dashboard build', () => {
  it('parses the hashed entry script of a built index.html', () => {
    expect(parseDashboardEntry(BUILT)).toBe('/assets/index-b91a9801.js');
    expect(parseDashboardEntry('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(parseDashboardEntry('<script src="/assets/legacy.js"></script>')).toBeNull();
    expect(parseDashboardEntry('')).toBeNull();
  });

  it('reads it from disk, null when there is no build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-build-'));
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, BUILT);
    expect(loadDashboardEntry(file)).toBe('/assets/index-b91a9801.js');
    expect(loadDashboardEntry(path.join(dir, 'missing.html'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps responses with the served build', async () => {
    const app = express();
    app.use(dashboardBuildHeader('/assets/index-b91a9801.js'));
    app.get('/x', (_req, res) => res.json({}));
    expect((await request(app).get('/x')).headers['x-crewly-dashboard-build']).toBe('/assets/index-b91a9801.js');
    const none = express();
    none.use(dashboardBuildHeader(null));
    none.get('/x', (_req, res) => res.json({}));
    expect((await request(none).get('/x')).headers['x-crewly-dashboard-build']).toBeUndefined();
  });

  it('builds the socket message', () => {
    expect(dashboardBuildMessage('/assets/a.js')).toMatchObject({ type: 'dashboard_build', payload: { entry: '/assets/a.js' } });
  });
});
