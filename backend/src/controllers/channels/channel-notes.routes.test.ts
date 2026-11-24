/**
 * Tests for the channel notes API.
 *
 * @module controllers/channels/channel-notes.routes.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { createChannelNotesRouter, parseCoverLine, patchFromBody } from './channel-notes.routes.js';
import { agentAuthHeaders, ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';
import { channelPageRelativePath } from '../../services/wiki/channel-page.js';
import { parsePage } from '../../services/wiki/wiki-page.js';

const ROOM = { id: 'room-1', name: '#necina' };

describe('/api/channel-notes', () => {
  let vault: string;
  let app: express.Express;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-notes-routes-'));
    app = express();
    app.use(ownerUnlessAgentForTests);
    app.use(express.json());
    app.use(
      '/api/channel-notes',
      createChannelNotesRouter({
        vaultPath: () => vault,
        findRoom: (ref) => {
          if (ref === 'boom') throw new Error('chat not ready');
          return ref === 'room-1' || ref === '#necina' || ref === '#100%-club' ? ROOM : null;
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true, maxRetries: 3 });
  });

  it('parses a cover line, with either colon', () => {
    expect(parseCoverLine('Atlas: the Saturday talk')).toEqual({ who: 'Atlas', what: 'the Saturday talk' });
    expect(parseCoverLine('Pia：视频和剪辑')).toEqual({ who: 'Pia', what: '视频和剪辑' });
    expect(parseCoverLine('no colon here')).toBeNull();
    expect(parseCoverLine(': nothing')).toBeNull();
    expect(parseCoverLine('Atlas:  ')).toBeNull();
  });

  it('reads a patch from a body and refuses a malformed or empty one', () => {
    expect(patchFromBody({ lead: 'Atlas', cover: 'Pia: video' })).toEqual({ patch: { lead: 'Atlas', cover: { who: 'Pia', what: 'video' } } });
    expect(patchFromBody({ lead: '' })).toEqual({ patch: { lead: '' } });
    expect(patchFromBody({ lead: 3 })).toEqual({ error: 'lead must be text' });
    expect(patchFromBody({ cover: 'Pia' })).toHaveProperty('error');
    expect(patchFromBody({})).toHaveProperty('error');
    expect(patchFromBody(null)).toHaveProperty('error');
  });

  it('an agent records the lead by room id; the page is read back by name', async () => {
    const posted = await request(app).post('/api/channel-notes/room-1').set(agentAuthHeaders('flopost-pia-1')).send({ lead: 'Atlas', cover: 'Atlas: the Saturday talk' });
    expect(posted.status).toBe(200);
    expect(posted.body.data.page).toMatchObject({ lead: 'Atlas', covers: [{ who: 'Atlas', what: 'the Saturday talk' }] });
    const raw = fs.readFileSync(path.join(vault, channelPageRelativePath(ROOM)), 'utf8');
    expect(parsePage(raw).frontmatter['lead_set_by']).toBe('flopost-pia-1');

    const read = await request(app).get(`/api/channel-notes/${encodeURIComponent('#necina')}`);
    expect(read.status).toBe(200);
    expect(read.body.data.channel).toEqual({ id: 'room-1', name: '#necina' });
    expect(read.body.data.page.lead).toBe('Atlas');
  });

  it('the owner changes it too; a page not written yet reads as null', async () => {
    expect((await request(app).get('/api/channel-notes/room-1')).body.data.page).toBeNull();
    const posted = await request(app).post('/api/channel-notes/room-1').send({ purpose: 'Talk prep' });
    expect(posted.status).toBe(200);
    expect(parsePage(fs.readFileSync(path.join(vault, channelPageRelativePath(ROOM)), 'utf8')).frontmatter.caller).toBe('owner');
  });

  it('a name with a percent sign is not decoded twice; a failing lookup answers 500', async () => {
    expect((await request(app).get(`/api/channel-notes/${encodeURIComponent('#100%-club')}`)).status).toBe(200);
    expect((await request(app).get('/api/channel-notes/boom')).status).toBe(500);
    expect((await request(app).post('/api/channel-notes/boom').send({ lead: 'x' })).status).toBe(500);
  });

  it('404 for an unknown room, 400 for a malformed change', async () => {
    expect((await request(app).get('/api/channel-notes/nope')).status).toBe(404);
    expect((await request(app).post('/api/channel-notes/nope').send({ lead: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/channel-notes/room-1').send({})).status).toBe(400);
    expect((await request(app).post('/api/channel-notes/room-1').send({ cover: 'nocolon' })).status).toBe(400);
  });
});
