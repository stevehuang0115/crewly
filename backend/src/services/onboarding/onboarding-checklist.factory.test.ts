/**
 * Tests for the onboarding checklist's real wiring.
 */

const harness = {
	orc: { get: jest.fn() },
	status: { getInstalledInfo: jest.fn(), getLoginInfo: jest.fn() },
};
const storage = { getTeams: jest.fn(async () => []), saveTeam: jest.fn(async () => undefined) };
const chatV2 = { getRecentOwnerMessageContents: jest.fn(() => [] as string[]) };
const cloud = { isConnected: jest.fn(() => false), getTier: jest.fn(() => 'pro') };
const slack = { isConnected: jest.fn(() => true) };
const sendChat = jest.fn();

jest.mock('../harness/harness.service.js', () => ({ getHarnessService: () => harness }));
jest.mock('../core/storage.service.js', () => ({ StorageService: { getInstance: () => storage } }));
jest.mock('../template/template.service.js', () => ({ TemplateService: { getInstance: () => ({ tag: 'templates' }) } }));
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({ getChatV2Service: () => chatV2 }));
jest.mock('../cloud/cloud-client.service.js', () => ({ CloudClientService: { getInstance: () => cloud } }));
jest.mock('../slack/slack.service.js', () => ({ getSlackService: () => slack }));
jest.mock('../../controllers/chat/chat.controller.js', () => ({ sendChatMessageToOrchestrator: (...args: unknown[]) => sendChat(...args) }));

import {
	createDefaultOnboardingDeps,
	getOnboardingChecklistService,
	readOrcHarnessState,
	sendViaChat,
	setOnboardingChecklistServiceForTesting,
} from './onboarding-checklist.factory.js';
import { OnboardingChecklistService } from './onboarding-checklist.service.js';

describe('readOrcHarnessState', () => {
	beforeEach(() => jest.clearAllMocks());

	it('reports no orc harness', async () => {
		harness.orc.get.mockResolvedValue(null);
		expect(await readOrcHarnessState()).toEqual({ orcHarness: null, installed: false, loginState: null });
	});

	it('treats a runtime outside the harness list as set up elsewhere', async () => {
		harness.orc.get.mockResolvedValue('crewly-agent');
		expect(await readOrcHarnessState()).toEqual({ orcHarness: 'crewly-agent', installed: true, loginState: 'unknown' });
		expect(harness.status.getInstalledInfo).not.toHaveBeenCalled();
	});

	it('reports a missing binary without probing the login', async () => {
		harness.orc.get.mockResolvedValue('claude-code');
		harness.status.getInstalledInfo.mockResolvedValue({ installed: false, path: null, version: null });
		expect(await readOrcHarnessState()).toEqual({ orcHarness: 'claude-code', installed: false, loginState: null });
		expect(harness.status.getLoginInfo).not.toHaveBeenCalled();
	});

	it('reads the login state of an installed harness', async () => {
		harness.orc.get.mockResolvedValue('codex-cli');
		harness.status.getInstalledInfo.mockResolvedValue({ installed: true, path: '/bin/codex', version: '0.1.0' });
		harness.status.getLoginInfo.mockResolvedValue({ loginState: 'logged_in', loginSource: 'chatgpt' });
		expect(await readOrcHarnessState()).toEqual({ orcHarness: 'codex-cli', installed: true, loginState: 'logged_in' });
		expect(harness.status.getLoginInfo).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex-cli' }), '/bin/codex');
	});
});

describe('sendViaChat', () => {
	it('maps the chat result', async () => {
		sendChat.mockResolvedValue({
			result: { conversation: { id: 'conv-9' }, message: { id: 'm' } },
			orchestrator: { forwarded: true, queued: true, error: 'offline, queued' },
		});
		expect(await sendViaChat('hi', { source: 's' })).toEqual({ conversationId: 'conv-9', forwarded: true, queued: true, error: 'offline, queued' });
		expect(sendChat).toHaveBeenCalledWith({ content: 'hi', metadata: { source: 's' } });
	});

	it('reports a message that was not forwarded', async () => {
		sendChat.mockResolvedValue({ result: { conversation: { id: 'c' } }, orchestrator: { forwarded: false } });
		expect(await sendViaChat('hi', {})).toEqual({ conversationId: 'c', forwarded: false, queued: false, error: null });
	});
});

describe('createDefaultOnboardingDeps', () => {
	it('reads owner messages, Cloud and Slack from the live services', async () => {
		const deps = createDefaultOnboardingDeps();
		expect(deps.hasOwnerMessage()).toBe(false);
		chatV2.getRecentOwnerMessageContents.mockReturnValue(['hello']);
		expect(deps.hasOwnerMessage()).toBe(true);
		expect(chatV2.getRecentOwnerMessageContents).toHaveBeenCalledWith(0, 1);
		expect(deps.getCloudState()).toEqual({ connected: false, tier: null });
		cloud.isConnected.mockReturnValue(true);
		expect(deps.getCloudState()).toEqual({ connected: true, tier: 'pro' });
		expect(deps.isSlackConnected()).toBe(true);
		expect(deps.templates()).toEqual({ tag: 'templates' });
		await deps.listTeams();
		expect(storage.getTeams).toHaveBeenCalled();
		expect(deps.now()).toBeInstanceOf(Date);
	});
});

describe('getOnboardingChecklistService', () => {
	afterEach(() => setOnboardingChecklistServiceForTesting(null));

	it('is a singleton that tests can replace', () => {
		const a = getOnboardingChecklistService();
		expect(a).toBeInstanceOf(OnboardingChecklistService);
		expect(getOnboardingChecklistService()).toBe(a);
		const fake = {} as OnboardingChecklistService;
		setOnboardingChecklistServiceForTesting(fake);
		expect(getOnboardingChecklistService()).toBe(fake);
	});
});
