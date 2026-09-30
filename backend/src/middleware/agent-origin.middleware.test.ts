import type { Request, Response } from 'express';
import { agentOriginMiddleware, setAgentOriginServiceForTesting } from './agent-origin.middleware.js';
import { AgentProcessOriginService, type ProcessOrigin } from '../services/agent/agent-process-origin.service.js';
import { LoggerService } from '../services/core/logger.service.js';

function fakeService(origin: ProcessOrigin | Promise<ProcessOrigin>): AgentProcessOriginService & { resolve: jest.Mock } {
	return { resolve: jest.fn().mockImplementation(() => Promise.resolve(origin)) } as unknown as AgentProcessOriginService & { resolve: jest.Mock };
}

function request(headers: Record<string, string>, remoteAddress = '127.0.0.1'): Request {
	return { headers: { ...headers }, socket: { remoteAddress }, path: '/chat/agent-response' } as unknown as Request;
}

function run(req: Request): Promise<void> {
	return new Promise((resolve) => agentOriginMiddleware(req, {} as Response, () => resolve()));
}

describe('agentOriginMiddleware', () => {
	let warn: jest.SpyInstance;

	beforeEach(() => {
		warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		warn.mockRestore();
		setAgentOriginServiceForTesting(null);
	});

	it('treats the request as the agent whose PTY the process runs under, keeping the claim', async () => {
		setAgentOriginServiceForTesting(fakeService({ session: 'team-avery-member-1', viaSharedDaemon: false }));
		const req = request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '402' });
		await run(req);
		expect(req.headers['x-agent-session']).toBe('team-avery-member-1');
		expect(req.headers['x-agent-session-claimed']).toBe('crewly-orc');
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('claimed another agent'),
			expect.objectContaining({ claimedSession: 'crewly-orc', actualSession: 'team-avery-member-1' }),
			expect.anything(),
		);
	});

	it('leaves a matching identity alone, silently', async () => {
		setAgentOriginServiceForTesting(fakeService({ session: 'crewly-orc', viaSharedDaemon: false }));
		const req = request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '402' });
		await run(req);
		expect(req.headers['x-agent-session']).toBe('crewly-orc');
		expect(req.headers['x-agent-session-claimed']).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it('warns (once) when the command ran in a shared Codex daemon, without changing the header', async () => {
		setAgentOriginServiceForTesting(fakeService({ session: null, viaSharedDaemon: true }));
		const req = request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '302' });
		await run(req);
		await run(request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '303' }));
		expect(req.headers['x-agent-session']).toBe('crewly-orc');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('shared Codex app-server'), expect.objectContaining({ claimedSession: 'crewly-orc' }), expect.anything());
	});

	it('never gives an anonymous request an identity, and ignores bad pids', async () => {
		const service = fakeService({ session: 'team-avery-member-1', viaSharedDaemon: false });
		setAgentOriginServiceForTesting(service);
		const anonymous = request({ 'x-agent-pid': '402' });
		await run(anonymous);
		expect(anonymous.headers['x-agent-session']).toBeUndefined();
		await run(request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': 'abc' }));
		await run(request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '1' }));
		await run(request({ 'x-agent-session': 'crewly-orc' }));
		expect(service.resolve).not.toHaveBeenCalled();
	});

	it('ignores remote callers (a pid only means something on this machine)', async () => {
		const service = fakeService({ session: 'team-avery-member-1', viaSharedDaemon: false });
		setAgentOriginServiceForTesting(service);
		const req = request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '402' }, '203.0.113.9');
		await run(req);
		expect(req.headers['x-agent-session']).toBe('crewly-orc');
		expect(service.resolve).not.toHaveBeenCalled();
	});

	it('passes the request through unchanged when the lookup fails', async () => {
		setAgentOriginServiceForTesting(fakeService(Promise.reject(new Error('ps failed'))));
		const req = request({ 'x-agent-session': 'crewly-orc', 'x-agent-pid': '402' });
		await run(req);
		expect(req.headers['x-agent-session']).toBe('crewly-orc');
	});
});
