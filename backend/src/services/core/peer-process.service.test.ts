/**
 * Tests for the local client-process classifier (#999).
 */

import { execFile, spawnSync } from 'child_process';
import * as http from 'http';
import {
  PeerProcessService,
  agentSignalFromTable,
  isHostAddress,
  parseLsofPeer,
  parsePsTable,
  parseSsPeer,
  type PeerProcessEntry,
} from './peer-process.service.js';

const SELF = 500;

/** Process table: backend 500 → shell 600 (agent PTY) → skill 700; browser 900; orphan 950 on the agent tty. */
function table(): Map<number, PeerProcessEntry> {
  return new Map<number, PeerProcessEntry>([
    [1, { ppid: 0, tty: '??' }],
    [SELF, { ppid: 1, tty: 'ttys001' }],
    [600, { ppid: SELF, tty: 'ttys009' }],
    [700, { ppid: 600, tty: 'ttys009' }],
    [900, { ppid: 1, tty: '??' }],
    [950, { ppid: 1, tty: 'ttys009' }],
    [960, { ppid: 1, tty: 'ttys002' }],
  ]);
}

const sessions = new Map<number, string>([[600, 'crewly-dev-sam']]);

describe('isHostAddress', () => {
  const ifaces = { en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never] };
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.5', '::ffff:192.168.1.5'])('%s is this host', (a) => {
    expect(isHostAddress(a, ifaces)).toBe(true);
  });
  it.each(['192.168.1.20', '10.0.0.1', ''])('%s is not', (a) => {
    expect(isHostAddress(a, ifaces)).toBe(false);
  });
});

describe('parsers', () => {
  it('lsof: picks the process whose local end is the client port', () => {
    const out = [
      'p500', 'f20', 'n127.0.0.1:8787->127.0.0.1:54321',
      'p700', 'f3', 'n127.0.0.1:54321->127.0.0.1:8787',
    ].join('\n');
    expect(parseLsofPeer(out, 54321, 8787)).toBe(700);
    expect(parseLsofPeer(out, 54322, 8787)).toBeNull();
    expect(parseLsofPeer('p700\nf3\nn[::1]:54321->[::1]:8787', 54321, 8787)).toBe(700);
  });

  it('ss: reads the pid of the connection to the server port', () => {
    const out = 'ESTAB 0 0 127.0.0.1:54321 127.0.0.1:8787 users:(("curl",pid=1234,fd=3))';
    expect(parseSsPeer(out, 8787)).toBe(1234);
    expect(parseSsPeer(out, 9999)).toBeNull();
    expect(parseSsPeer('', 8787)).toBeNull();
  });

  it('ps: parses pid, ppid and tty', () => {
    const t = parsePsTable('  1     0 ??\n600   500 ttys009\n');
    expect(t.get(600)).toEqual({ ppid: 500, tty: 'ttys009' });
  });
});

describe('agentSignalFromTable', () => {
  it('a skill under an agent PTY is an agent (ancestry), named by its PTY', () => {
    expect(agentSignalFromTable(700, table(), SELF, sessions)).toEqual({ signal: 'ancestry', session: 'crewly-dev-sam' });
  });
  it('a direct child of the backend is an agent', () => {
    expect(agentSignalFromTable(600, table(), SELF, sessions)?.signal).toBe('ancestry');
  });
  it('an orphan that kept the agent PTY is an agent (tty)', () => {
    expect(agentSignalFromTable(950, table(), SELF, sessions)).toEqual({ signal: 'tty', session: 'crewly-dev-sam' });
  });
  it('the owner browser and terminal are not', () => {
    expect(agentSignalFromTable(900, table(), SELF, sessions)).toBeNull();
    expect(agentSignalFromTable(960, table(), SELF, sessions)).toBeNull();
  });
});

describe('PeerProcessService', () => {
  const socket = (port = 54321, address = '127.0.0.1') => ({ remoteAddress: address, remotePort: port, localPort: 8787 });

  function service(pid: number | null, env: Record<string, string> | null = {}) {
    const findPeerPid = jest.fn(async () => pid);
    const svc = new PeerProcessService({
      findPeerPid,
      readTable: async () => table(),
      readEnv: async () => env,
      listSessionPids: () => sessions,
      selfPid: SELF,
      isHostAddress: (a) => a === '127.0.0.1',
    });
    return { svc, findPeerPid };
  }

  it('a remote address needs no lookup', async () => {
    const { svc, findPeerPid } = service(700);
    expect(await svc.classify(socket(1, '192.168.1.20'))).toEqual({ kind: 'remote' });
    expect(findPeerPid).not.toHaveBeenCalled();
  });

  it('classifies agent, browser and self', async () => {
    expect((await service(700).svc.classify(socket())).kind).toBe('agent');
    expect(await service(900).svc.classify(socket())).toEqual({ kind: 'not-agent', pid: 900 });
    expect(await service(SELF).svc.classify(socket())).toEqual({ kind: 'self' });
  });

  it('an orphan that shed its tty but kept the agent env is an agent', async () => {
    const verdict = await service(900, { CREWLY_SESSION_NAME: 'crewly-dev-sam' }).svc.classify(socket());
    expect(verdict).toEqual({ kind: 'agent', pid: 900, signal: 'env', session: 'crewly-dev-sam' });
  });

  it('caches per socket', async () => {
    const { svc, findPeerPid } = service(900);
    const s = socket();
    await svc.classify(s);
    await svc.classify(s);
    expect(findPeerPid).toHaveBeenCalledTimes(1);
    await svc.classify(socket(54322));
    expect(findPeerPid).toHaveBeenCalledTimes(2);
  });

  it('answers unknown when the client process cannot be found, fails or times out', async () => {
    expect((await service(null).svc.classify(socket())).kind).toBe('unknown');
    const failing = new PeerProcessService({ findPeerPid: async () => { throw new Error('no lsof'); }, isHostAddress: () => true });
    expect((await failing.classify(socket())).kind).toBe('unknown');
    const slow = new PeerProcessService({ findPeerPid: () => new Promise(() => undefined), isHostAddress: () => true, timeoutMs: 20 });
    expect((await slow.classify(socket())).kind).toBe('unknown');
    expect((await failing.classify(null)).kind).toBe('unknown');
  });
});

describe('PeerProcessService against real processes (lsof / ss + ps)', () => {
  const hasTool = (() => {
    const probe = process.platform === 'linux' ? spawnSync('ss', ['-V']) : spawnSync('lsof', ['-v']);
    return !probe.error;
  })();
  const maybe = hasTool ? it : it.skip;

  /** A local server whose request handler classifies the caller. */
  async function serve(svc: PeerProcessService): Promise<{ port: number; verdicts: unknown[]; close: () => Promise<void> }> {
    const verdicts: unknown[] = [];
    const server = http.createServer((req, res) => {
      void svc.classify(req.socket).then((v) => {
        verdicts.push(v);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return { port, verdicts, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  maybe('a child process of this one (an "agent") is classified by ancestry; this process itself is "self"', async () => {
    const svc = new PeerProcessService({ timeoutMs: 10_000 });
    const srv = await serve(svc);
    try {
      await new Promise<void>((resolve, reject) =>
        execFile('curl', ['-s', `http://127.0.0.1:${srv.port}/`], (err) => (err ? reject(err) : resolve())),
      );
      await new Promise<void>((resolve) => {
        http.get({ host: '127.0.0.1', port: srv.port, path: '/', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
      });
      expect(srv.verdicts[0]).toMatchObject({ kind: 'agent', signal: 'ancestry' });
      expect(srv.verdicts[1]).toEqual({ kind: 'self' });
    } finally {
      await srv.close();
    }
  }, 30_000);
});
