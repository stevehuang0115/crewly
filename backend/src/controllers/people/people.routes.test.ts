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
		// The owner is always "owner"; their Slack id is listed on the row.
		expect(res.body.data.ownerId).toBe('owner');
		expect(res.body.data.people.map((p: { id: string }) => p.id)).toEqual(['owner', 'UINFO001']);
		expect(res.body.data.people[0].slackUserIds).toEqual(['UOWNER01']);
	});

	it('the owner adds, edits and removes people', async () => {
		expect((await request(app).put('/api/people/USTEVE01').send({ name: 'Steve', role: 'guest' })).body.data).toMatchObject({ id: 'USTEVE01', role: 'guest' });
		expect((await request(app).put('/api/people/bad').send({ name: 'x' })).status).toBe(400);
		expect((await request(app).put('/api/people/UOWNER01').send({ role: 'member' })).status).toBe(400);
		expect((await request(app).delete('/api/people/USTEVE01')).status).toBe(200);
		expect((await request(app).delete('/api/people/USTEVE01')).status).toBe(404);
		expect((await request(app).delete('/api/people/UOWNER01')).status).toBe(400);
		// "Owner (me)": the owner marks a second Slack account as their own.
		const mine = await request(app).put('/api/people/UOWNER02').send({ role: 'owner' });
		expect(mine.status).toBe(200);
		expect(mine.body.data).toMatchObject({ id: 'owner', slackUserIds: ['UOWNER01', 'UOWNER02'] });
	});

	it('an agent can read but never change the directory', async () => {
		expect((await request(app).get('/api/people').set('X-Agent-Session', 'dev-1')).status).toBe(200);
		const put = await request(app).put('/api/people/UGUEST01').set('X-Agent-Session', 'dev-1').send({ role: 'member' });
		expect(put.status).toBe(403);
		expect((await request(app).delete('/api/people/UINFO001').set('X-Agent-Session', 'dev-1')).status).toBe(403);
	});
});
