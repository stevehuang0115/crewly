import { isColleagueWireMessage, type ColleagueWireMessage } from './colleague-message.types.js';

const valid: ColleagueWireMessage = {
  v: 1,
  id: 'm1',
  from: { instanceId: 'dev-air', deviceName: 'iriss-air.lan', session: 'steamfun-fern', name: 'Fern', team: 'SteamFun' },
  toSession: 'flopost-pia',
  text: 'Hello Pia',
  sentAt: '2026-11-10T10:00:00.000Z',
};

describe('isColleagueWireMessage', () => {
  it('accepts a well-formed message, with and without optional fields', () => {
    expect(isColleagueWireMessage(valid)).toBe(true);
    expect(isColleagueWireMessage({ ...valid, replyTo: 'm0', toName: 'Pia' })).toBe(true);
    expect(isColleagueWireMessage({ ...valid, from: { ...valid.from, team: undefined } })).toBe(true);
  });

  it('rejects non-objects, a wrong version and missing required fields', () => {
    expect(isColleagueWireMessage(null)).toBe(false);
    expect(isColleagueWireMessage('x')).toBe(false);
    expect(isColleagueWireMessage({ ...valid, v: 2 })).toBe(false);
    expect(isColleagueWireMessage({ ...valid, id: '' })).toBe(false);
    expect(isColleagueWireMessage({ ...valid, text: undefined })).toBe(false);
    expect(isColleagueWireMessage({ ...valid, toSession: 5 })).toBe(false);
    expect(isColleagueWireMessage({ ...valid, from: undefined })).toBe(false);
    expect(isColleagueWireMessage({ ...valid, from: { ...valid.from, instanceId: '' } })).toBe(false);
    expect(isColleagueWireMessage({ ...valid, replyTo: 7 })).toBe(false);
  });
});
