/**
 * Tests for the people directory API (issue #968).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { createPeopleRouter } from './people.routes.js';
import { PeopleDirectoryService } from '../../services/people/people-directory.service.js';

describe('/api/people', () => {
	let dir: string;
	let directory: PeopleDirectoryService;
	let app: express.Express;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-routes-'));
		directory = new PeopleDirectoryService({ filePath: path.join(dir, 'people.json'), getOwnerSlackUserId: () => 'UOWNER01' });
		app = express();
		app.use(express.json());
		app.use('/api/people', createPeopleRouter(() => directory));
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('lists everyone with the owner first', async () => {
		directory.noteSeen('UINFO001', 'Info');
		const res = await request(app).get('/api/people');
		expect(res.status).toBe(200);
		expect(res.body.data.ownerId).toBe('UOWNER01');
		expect(res.body.data.people.map((p: { id: string }) => p.id)).toEqual(['UOWNER01', 'UINFO001']);
	});

	it('the owner adds, edits and removes people', async () => {
		expect((await request(app).put('/api/people/USTEVE01').send({ name: 'Steve', role: 'guest' })).body.data).toMatchObject({ id: 'USTEVE01', role: 'guest' });
		expect((await request(app).put('/api/people/USTEVE01').send({ role: 'owner' })).status).toBe(400);
		expect((await request(app).put('/api/people/bad').send({ name: 'x' })).status).toBe(400);
		expect((await request(app).delete('/api/people/USTEVE01')).status).toBe(200);
		expect((await request(app).delete('/api/people/USTEVE01')).status).toBe(404);
		expect((await request(app).delete('/api/people/UOWNER01')).status).toBe(400);
	});

	it('an agent can read but never change the directory', async () => {
		expect((await request(app).get('/api/people').set('X-Agent-Session', 'dev-1')).status).toBe(200);
		const put = await request(app).put('/api/people/UGUEST01').set('X-Agent-Session', 'dev-1').send({ role: 'member' });
		expect(put.status).toBe(403);
		expect((await request(app).delete('/api/people/UINFO001').set('X-Agent-Session', 'dev-1')).status).toBe(403);
	});
});
