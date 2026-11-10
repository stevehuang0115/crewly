const sessionExists = jest.fn();
jest.mock('../session/index.js', () => ({ getSessionBackendSync: () => ({ sessionExists }) }));
const queueForOfflineAgent = jest.fn();
jest.mock('./offline-agent-message.js', () => ({ queueForOfflineAgent: (...a: unknown[]) => queueForOfflineAgent(...a), getOfflineAgentWaker: () => null }));
jest.mock('../core/storage.service.js', () => ({ StorageService: { getInstance: () => ({ findMemberBySessionName: jest.fn() }) } }));
jest.mock('./sub-agent-message-queue.service.js', () => ({ SubAgentMessageQueue: { getInstance: () => ({ enqueue: jest.fn() }) } }));

import { deliverToLocalAgent, type LocalAgentRegistration } from './deliver-to-local-agent.js';

function reg(over: Partial<Record<keyof LocalAgentRegistration, jest.Mock>> = {}) {
  return {
    getInProcessRuntime: jest.fn(() => null),
    waitForAgentReady: jest.fn(async () => true),
    holdForBusyAgent: jest.fn(),
    sendMessageToAgent: jest.fn(async () => ({ success: true })),
    ...over,
  } as unknown as LocalAgentRegistration & Record<string, jest.Mock>;
}

describe('deliverToLocalAgent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails without a registration service', async () => {
    expect(await deliverToLocalAgent(null, 's', 't', 10)).toEqual({ success: false, error: 'agent delivery is not ready yet' });
  });

  it('sends now to a running, ready agent', async () => {
    sessionExists.mockReturnValue(true);
    const r = reg();
    expect(await deliverToLocalAgent(r, 's', 'hi', 10)).toEqual({ success: true });
    expect(r.sendMessageToAgent).toHaveBeenCalledWith('s', 'hi');
    expect(r.waitForAgentReady).toHaveBeenCalledWith('s', 10);
  });

  it('holds for a busy agent', async () => {
    sessionExists.mockReturnValue(true);
    const r = reg({ waitForAgentReady: jest.fn(async () => false) });
    expect(await deliverToLocalAgent(r, 's', 'hi', 10)).toEqual({ success: true, queued: true });
    expect(r.holdForBusyAgent).toHaveBeenCalledWith('s', 'hi');
    expect(r.sendMessageToAgent).not.toHaveBeenCalled();
  });

  it('passes on a send failure', async () => {
    sessionExists.mockReturnValue(true);
    const r = reg({ sendMessageToAgent: jest.fn(async () => ({ success: false, error: 'boom' })) });
    expect(await deliverToLocalAgent(r, 's', 'hi', 10)).toEqual({ success: false, error: 'boom' });
  });

  it('queues for an agent that is down, and says so when it cannot', async () => {
    sessionExists.mockReturnValue(false);
    queueForOfflineAgent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await deliverToLocalAgent(reg(), 's', 'hi', 10)).toEqual({ success: true, queued: true });
    expect(queueForOfflineAgent).toHaveBeenCalledWith('s', 'hi', expect.objectContaining({ findMember: expect.any(Function), enqueue: expect.any(Function) }));
    expect(await deliverToLocalAgent(reg(), 's', 'hi', 10)).toEqual({ success: false, error: 's is not running' });
  });

  it('treats an in-process runtime as running', async () => {
    sessionExists.mockReturnValue(false);
    const r = reg({ getInProcessRuntime: jest.fn(() => ({})) });
    expect(await deliverToLocalAgent(r, 's', 'hi', 10)).toEqual({ success: true });
  });
});
