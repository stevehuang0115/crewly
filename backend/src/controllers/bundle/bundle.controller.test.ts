/**
 * Tests for the bundle controller over HTTP: list / detail, apply (202),
 * job progress, error mapping, and owner-only apply + job reads
 * (`X-Agent-Session` → 403).
 */

import express from 'express';
import request from 'supertest';
import type { BundleTemplate, BundleDeployment } from '../../types/solution-bundle.types.js';
import { BundleError, type BundleApplyService } from '../../services/bundle/bundle-apply.service.js';
import type { BundleCatalog, BundleCatalogEntry } from '../../services/bundle/bundle-catalog.js';
import { createBundleRouter } from './bundle.routes.js';

jest.mock('../../services/bundle/bundle-apply.factory.js', () => ({
  getBundleApplyService: jest.fn(),
  getBundleCatalog: jest.fn(),
}));

/** A bundle template. */
function template(id: string, status: 'ready' | 'draft' = 'ready'): BundleTemplate {
  return {
    id,
    name: id,
    description: 'd',
    roles: [{ role: 'team-leader', label: 'Lead', defaultName: 'Ava', count: 1, hierarchyLevel: 1, canDelegate: true, defaultSkills: [] }],
    bundle: {
      schemaVersion: 1,
      status,
      label: `L ${id}`,
      tagline: 't',
      ownerSummary: 's',
      runtime: { recommended: 'crewly-agent' },
      server: { tier: 'entry' },
      questions: [{ id: 'business_name', label: '名字', type: 'text', required: true }],
    },
  };
}

const DEPLOYMENT = { templateId: 'smb', jobId: 'job-1', status: 'running', steps: [] } as unknown as BundleDeployment;

describe('bundle routes', () => {
  let service: { start: jest.Mock; getJob: jest.Mock; getDeployment: jest.Mock };
  let app: express.Express;

  beforeEach(() => {
    service = {
      start: jest.fn(async () => DEPLOYMENT),
      getJob: jest.fn(async () => DEPLOYMENT),
      getDeployment: jest.fn(async () => null),
    };
    const entries: BundleCatalogEntry[] = [template('smb'), template('draft-one', 'draft')].map((t) => ({
      template: t,
      dir: '/x',
      file: '/x/template.json',
      validation: { ok: true, errors: [] },
    }));
    const catalog: Pick<BundleCatalog, 'list' | 'get'> = {
      list: ({ includeDrafts } = {}) => entries.filter((e) => includeDrafts || e.template.bundle.status !== 'draft'),
      get: (id) => entries.find((e) => e.template.id === id) ?? null,
    };
    app = express();
    app.use(express.json());
    app.use('/api/bundles', createBundleRouter(() => service as unknown as BundleApplyService, () => catalog));
  });

  it('GET / lists ready bundles; ?drafts=1 adds drafts', async () => {
    const res = await request(app).get('/api/bundles');
    expect(res.status).toBe(200);
    expect(res.body.data.bundles.map((b: { id: string }) => b.id)).toEqual(['smb']);
    const all = await request(app).get('/api/bundles?drafts=1');
    expect(all.body.data.bundles.map((b: { id: string }) => b.id)).toEqual(['smb', 'draft-one']);
  });

  it('GET /:id returns questions and the deployment on this machine', async () => {
    const res = await request(app).get('/api/bundles/smb');
    expect(res.status).toBe(200);
    expect(res.body.data.bundle.questions[0].id).toBe('business_name');
    expect(res.body.data.deployment).toBeNull();
    const missing = await request(app).get('/api/bundles/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('unknown_bundle');
  });

  it('POST /apply starts a job (202) with the request fields', async () => {
    const res = await request(app).post('/api/bundles/apply').send({ templateId: 'smb', answers: { business_name: 'x' }, runtime: 'crewly-agent' });
    expect(res.status).toBe(202);
    expect(res.body.data.jobId).toBe('job-1');
    expect(service.start).toHaveBeenCalledWith({ templateId: 'smb', answers: { business_name: 'x' }, runtime: 'crewly-agent', allowDraft: false });
  });

  it('POST /apply maps engine errors, including the missing answers', async () => {
    service.start.mockRejectedValueOnce(
      new BundleError('invalid_answers', '还没回答：名字', { missing: [{ id: 'business_name', label: '名字', reason: '必填' }], invalid: [] }),
    );
    const res = await request(app).post('/api/bundles/apply').send({ templateId: 'smb', answers: {} });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'invalid_answers', missing: [{ id: 'business_name' }] });
    service.start.mockRejectedValueOnce(new BundleError('bundle_not_ready', 'draft'));
    expect((await request(app).post('/api/bundles/apply').send({ templateId: 'x' })).status).toBe(409);
    service.start.mockRejectedValueOnce(new Error('boom'));
    expect((await request(app).post('/api/bundles/apply').send({ templateId: 'x' })).status).toBe(500);
    expect((await request(app).post('/api/bundles/apply').send({})).status).toBe(404);
  });

  it('GET /apply/:jobId returns progress, 404 for an unknown job', async () => {
    expect((await request(app).get('/api/bundles/apply/job-1')).body.data.jobId).toBe('job-1');
    expect(service.getJob).toHaveBeenCalledWith('job-1');
    service.getJob.mockRejectedValueOnce(new BundleError('job_not_found', 'nope'));
    expect((await request(app).get('/api/bundles/apply/nope')).status).toBe(404);
  });

  it('is owner-only: an agent cannot deploy or read an apply job', async () => {
    const apply = await request(app).post('/api/bundles/apply').set('X-Agent-Session', 'crewly-orc').send({ templateId: 'smb', answers: {} });
    expect(apply.status).toBe(403);
    expect(apply.body.error).toMatch(/Only the owner/);
    const job = await request(app).get('/api/bundles/apply/job-1').set('X-Agent-Session', 'some-agent');
    expect(job.status).toBe(403);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.getJob).not.toHaveBeenCalled();
    // Catalog reads stay open.
    expect((await request(app).get('/api/bundles').set('X-Agent-Session', 'some-agent')).status).toBe(200);
  });
});
