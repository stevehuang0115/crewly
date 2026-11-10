import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';

const sync = {
  isStarted: jest.fn(),
  getDevices: jest.fn(),
  sendToPeerQueueId: jest.fn(),
  on: jest.fn(),
};
const cloudClient = { getToken: jest.fn(() => 'tok'), getCloudUrl: jest.fn(() => 'https://cloud.test') };
jest.mock('../cloud/cloud-client.service.js', () => ({ CloudClientService: { getInstance: () => cloudClient } }));
const fetchMock = jest.fn();
(globalThis as { fetch: unknown }).fetch = fetchMock;
/** Cloud's machine list answer */
function instancesAnswer(rows: Array<{ instanceId: string; relayQueueId: string }>): void {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: rows }) });
}
jest.mock('../cloud/cloud-sync.service.js', () => ({ CloudSyncService: { getInstance: () => sync } }));
jest.mock('../cloud/device-identity.service.js', () => ({
  DeviceIdentityService: { getInstance: () => ({ getOrCreateIdentity: async () => ({ deviceId: 'dev-air', deviceName: 'iriss-air.lan' }) }) },
}));
const dirList = jest.fn();
jest.mock('../slack/slack-directory.service.js', () => ({ getSlackDirectoryService: () => ({ list: dirList }) }));

import { buildColleagueDeps, resetAccountInstancesCache, lookupColleagueHint, startColleagueMessaging, getColleagueMessageService, setColleagueMessageService } from './colleague.wiring.js';
import type { ColleagueWireMessage } from './colleague-message.types.js';

const wire = { v: 1, id: 'm1' } as ColleagueWireMessage;

describe('colleague wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAccountInstancesCache();
    instancesAnswer([]);
  });

  describe('sendRemote (the relay path)', () => {
    it('sends to the queue the machine polls now, from the account machine list', async () => {
      sync.isStarted.mockReturnValue(true);
      // The device list still points the instance id at an old queue (Fern → Pia, 11-10).
      sync.getDevices.mockReturnValue([{ deviceId: 'dev-mac', sessionId: 'dev-mac', status: 'online' }]);
      instancesAnswer([{ instanceId: 'dev-mac', relayQueueId: 'q-live' }]);
      sync.sendToPeerQueueId.mockResolvedValue(undefined);
      const out = await buildColleagueDeps().sendRemote('dev-mac', wire);
      expect(out).toEqual({ ok: true });
      expect(sync.sendToPeerQueueId).toHaveBeenCalledWith('q-live', COLLEAGUE_MESSAGE_CONSTANTS.MESSAGE_TYPE, wire);
      expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/api/cloud/slack/instances', expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }));
    });

    it('falls back to the device list when Cloud does not list the machine', async () => {
      sync.isStarted.mockReturnValue(true);
      sync.getDevices.mockReturnValue([{ deviceId: 'dev-mac', sessionId: 'q-mac', status: 'online' }]);
      fetchMock.mockRejectedValue(new Error('down'));
      sync.sendToPeerQueueId.mockResolvedValue(undefined);
      expect(await buildColleagueDeps().sendRemote('dev-mac', wire)).toEqual({ ok: true });
      expect(sync.sendToPeerQueueId).toHaveBeenCalledWith('q-mac', COLLEAGUE_MESSAGE_CONSTANTS.MESSAGE_TYPE, wire);
    });

    it('never addresses a machine that is not one of this account\'s machines', async () => {
      sync.isStarted.mockReturnValue(true);
      sync.getDevices.mockReturnValue([{ deviceId: 'dev-mac', sessionId: 'q-mac', status: 'online' }]);
      instancesAnswer([{ instanceId: 'dev-mac', relayQueueId: 'q-live' }]);
      const out = await buildColleagueDeps().sendRemote('dev-stranger', wire);
      expect(out).toMatchObject({ ok: false, code: 'machine_unknown' });
      expect(sync.sendToPeerQueueId).not.toHaveBeenCalled();
    });

    it('reports Cloud as unavailable when sync is not running', async () => {
      sync.isStarted.mockReturnValue(false);
      expect(await buildColleagueDeps().sendRemote('dev-mac', wire)).toMatchObject({ ok: false, code: 'cloud_unavailable' });
    });

    it('turns a relay error into send_failed with its message', async () => {
      sync.isStarted.mockReturnValue(true);
      sync.getDevices.mockReturnValue([]);
      instancesAnswer([{ instanceId: 'dev-mac', relayQueueId: 'q-live' }]);
      sync.sendToPeerQueueId.mockRejectedValue(new Error('Peer queue not found'));
      expect(await buildColleagueDeps().sendRemote('dev-mac', wire)).toEqual({ ok: false, code: 'send_failed', error: 'Peer queue not found' });
    });
  });

  describe('isAccountMachine', () => {
    it('knows a sender listed only in the account machine list', async () => {
      sync.getDevices.mockReturnValue([]);
      instancesAnswer([{ instanceId: 'dev-air', relayQueueId: 'q-air' }]);
      const { accountInstances } = await import('./colleague.wiring.js');
      await accountInstances();
      expect(buildColleagueDeps().isAccountMachine('dev-air')).toBe(true);
      expect(buildColleagueDeps().isAccountMachine('dev-stranger')).toBe(false);
    });
  });

  describe('lookupColleagueHint (local send not found)', () => {
    it('names the machine and team of a colleague on another machine', async () => {
      dirList.mockResolvedValue([
        { name: 'Pia', agentSession: 'flopost-pia', team: 'Flopost', machine: 'steves-mac', source: 'this-account', kind: 'agent', mention: null, botUserId: null, inChannel: false },
      ]);
      expect(await lookupColleagueHint('Pia', 'steamfun-fern')).toBe('Pia is on the machine "steves-mac", team Flopost — use message-colleague --to Pia');
    });

    it('is null for an unknown name or an unreachable directory', async () => {
      dirList.mockResolvedValue([]);
      expect(await lookupColleagueHint('Nobody')).toBeNull();
      dirList.mockRejectedValue(new Error('down'));
      expect(await lookupColleagueHint('Pia')).toBeNull();
    });
  });

  describe('startColleagueMessaging', () => {
    it('listens for colleague_message on the relay once and routes it to the service', async () => {
      setColleagueMessageService(null);
      await startColleagueMessaging({} as never);
      await startColleagueMessaging({} as never);
      expect(sync.on).toHaveBeenCalledTimes(1);
      expect(getColleagueMessageService()).not.toBeNull();
      const [event, handler] = sync.on.mock.calls[0];
      expect(event).toBe('message');
      const receive = jest.spyOn(getColleagueMessageService()!, 'receive').mockResolvedValue({ handled: false, reason: 'malformed' });
      handler({ type: 'agent_message', payload: {} });
      expect(receive).not.toHaveBeenCalled();
      handler({ type: 'colleague_message', payload: { x: 1 } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(receive).toHaveBeenCalledWith({ x: 1 });
    });
  });
});
