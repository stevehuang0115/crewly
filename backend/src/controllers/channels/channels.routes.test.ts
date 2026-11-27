/**
 * Tests for the Crewly channels API: owner-only mutations, agent reads,
 * error mapping.
 *
 * @module controllers/channels/channels.routes.test
 */

import express from 'express';
import request from 'supertest';
import { createChannelsRouter } from './channels.routes.js';
import { CrewlyChannelError, type CrewlyChannelService } from '../../services/channels/crewly-channel.service.js';
import { agentAuthHeaders, callerIdentityForTests, ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';

const CHANNEL = { id: 'huddle-1', name: 'tech-brief', origin: 'crewly', createdAt: 'now', slack: null, members: [] };

function fakeService() {
  return {
    list: jest.fn(async () => [CHANNEL]),
    get: jest.fn(async () => CHANNEL),
    refresh: jest.fn(async () => [CHANNEL]),
    create: jest.fn(async () => CHANNEL),
    rename: jest.fn(async () => ({ ...CHANNEL, name: 'morning-brief' })),
    addMember: jest.fn(async () => ({ channel: CHANNEL, change: {} })),
    removeMember: jest.fn(async () => ({ channel: CHANNEL, change: {} })),
    archive: jest.fn(async () => ({ ...CHANNEL, archivedAt: 'now' })),
  };
}

describe('/api/channels', () => {
  let service: ReturnType<typeof fakeService>;
  let app: express.Express;

  beforeEach(() => {
    service = fakeService();
    app = express();
    app.use(ownerUnlessAgentForTests);
    app.use(express.json());
    app.use('/api/channels', createChannelsRouter(() => service as unknown as CrewlyChannelService));
  });

  it('lists channels; ?member= and ?archived= are passed through', async () => {
    const res = await request(app).get('/api/channels?member=eng-atlas&archived=true');
    expect(res.status).toBe(200);
    expect(res.body.data.channels).toEqual([CHANNEL]);
    expect(service.list).toHaveBeenCalledWith({ member: 'eng-atlas', includeArchived: true });
  });

  it('the owner creates, renames, adds/removes members and archives', async () => {
    const created = await request(app).post('/api/channels').send({ name: 'Tech Brief', purpose: 'p', memberSessions: ['a', 'b'] });
    expect(created.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith({ name: 'Tech Brief', purpose: 'p', memberSessions: ['a', 'b'] });
    expect((await request(app).patch('/api/channels/huddle-1').send({ name: 'Morning Brief' })).body.data.name).toBe('morning-brief');
    expect((await request(app).post('/api/channels/huddle-1/members').send({ sessionName: 'a' })).status).toBe(200);
    expect(service.addMember).toHaveBeenCalledWith('huddle-1', 'a');
    expect((await request(app).delete('/api/channels/huddle-1/members/a')).status).toBe(200);
    expect(service.removeMember).toHaveBeenCalledWith('huddle-1', 'a');
    expect((await request(app).post('/api/channels/huddle-1/archive')).body.data.archivedAt).toBe('now');
    expect((await request(app).post('/api/channels/refresh')).status).toBe(200);
  });

  it('an agent can read a channel but never change one', async () => {
    expect((await request(app).get('/api/channels/%23tech-brief').set('X-Agent-Session', 'eng-atlas')).status).toBe(200);
    expect(service.get).toHaveBeenCalledWith('#tech-brief');
    const create = await request(app).post('/api/channels').set('X-Agent-Session', 'eng-atlas').send({ name: 'x', memberSessions: ['a'] });
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('owner_only');
    expect((await request(app).post('/api/channels/huddle-1/members').set('X-Agent-Session', 'eng-atlas').send({ sessionName: 'eng-atlas' })).status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.addMember).not.toHaveBeenCalled();
  });

  it('maps service errors to their status and answers 503 before the service exists', async () => {
    service.create.mockRejectedValueOnce(new CrewlyChannelError('#x already exists', 409, 'conflict'));
    const res = await request(app).post('/api/channels').send({ name: 'x', memberSessions: ['a'] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'conflict', message: '#x already exists' });
    service.get.mockRejectedValueOnce(new Error('boom'));
    expect((await request(app).get('/api/channels/x')).status).toBe(500);

    const bare = express();
    bare.use(ownerUnlessAgentForTests);
    bare.use('/api/channels', createChannelsRouter(() => null));
    expect((await request(bare).get('/api/channels')).status).toBe(503);
  });

  describe('the orchestrator acts for the owner (2026-10-13)', () => {
    let real: express.Express;
    const compose = { compose: jest.fn(async () => ({ channel: { id: 'h', name: 'x', slackChannelId: 'C1', created: true }, added: [], requested: [], notFound: [], ambiguous: [], failed: [], directoryUnavailable: false })) };

    beforeEach(() => {
      real = express();
      real.use(callerIdentityForTests());
      real.use(express.json());
      real.use('/api/channels', createChannelsRouter(() => service as unknown as CrewlyChannelService, () => compose as never));
    });

    it('lets a verified orchestrator create, add members and compose', async () => {
      const orc = agentAuthHeaders('crewly-orc');
      expect((await request(real).post('/api/channels').set(orc).send({ name: 'x', memberSessions: ['a'] })).status).toBe(201);
      expect((await request(real).post('/api/channels/huddle-1/members').set(orc).send({ sessionName: 'a' })).status).toBe(200);
      const composed = await request(real).post('/api/channels/compose').set(orc).send({ name: 'x', members: ['Owen'] });
      expect(composed.status).toBe(201);
      expect(compose.compose).toHaveBeenCalledWith({ name: 'x', channel: undefined, purpose: undefined, members: ['Owen'] });
    });

    it('lets a verified orchestrator rename, and refuses every other caller', async () => {
      const send = (headers: Record<string, string>) => request(real).patch('/api/channels/huddle-1').set(headers).send({ name: 'n' });
      expect((await send(agentAuthHeaders('eng-atlas'))).status).toBe(403);
      expect((await send({ 'X-Agent-Session': 'crewly-orc' })).status).toBe(403);
      expect(service.rename).not.toHaveBeenCalled();
      expect((await send(agentAuthHeaders('crewly-orc'))).status).toBe(200);
      expect(service.rename).toHaveBeenCalledWith('huddle-1', 'n');
    });

    it('still refuses every other agent, and the orc on other mutations', async () => {
      const atlas = agentAuthHeaders('eng-atlas');
      expect((await request(real).post('/api/channels').set(atlas).send({ name: 'x', memberSessions: ['a'] })).status).toBe(403);
      expect((await request(real).post('/api/channels/compose').set(atlas).send({ name: 'x', members: ['Owen'] })).status).toBe(403);
      expect((await request(real).post('/api/channels/huddle-1/members').set(atlas).send({ sessionName: 'a' })).status).toBe(403);
      // The bare header is not proof of being the orchestrator.
      expect((await request(real).post('/api/channels').set('X-Agent-Session', 'crewly-orc').send({ name: 'x', memberSessions: ['a'] })).status).toBe(403);
      const orc = agentAuthHeaders('crewly-orc');
      expect((await request(real).delete('/api/channels/huddle-1/members/a').set(orc)).status).toBe(403);
      expect((await request(real).post('/api/channels/huddle-1/archive').set(orc)).status).toBe(403);
    });
  });
});
