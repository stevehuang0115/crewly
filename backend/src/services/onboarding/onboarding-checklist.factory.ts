/**
 * Real wiring of the onboarding checklist (backend singleton).
 *
 * Kept apart from `onboarding-checklist.service.ts` so the service can be
 * tested with plain fakes and the CLI can import the service without pulling
 * in the backend's singletons.
 *
 * @module services/onboarding/onboarding-checklist.factory
 */

import { getHarnessService } from '../harness/harness.service.js';
import { getHarnessDefinition } from '../harness/harness-registry.js';
import { isHarnessId } from '../harness/harness.types.js';
import { StorageService } from '../core/storage.service.js';
import { TemplateService } from '../template/template.service.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import { CloudClientService } from '../cloud/cloud-client.service.js';
import { getSlackService } from '../slack/slack.service.js';
import { sendChatMessageToOrchestrator } from '../../controllers/chat/chat.controller.js';
import { OnboardingStateStore } from './onboarding-state.store.js';
import {
	OnboardingChecklistService,
	type HarnessStepDetail,
	type OnboardingChecklistDeps,
	type OrchestratorSendResult,
} from './onboarding-checklist.service.js';

/**
 * The orchestrator harness's state, read the way `/api/harness` reads it but
 * without the npm "latest version" lookup (the checklist only needs
 * installed + login).
 *
 * @returns Harness step detail
 */
export async function readOrcHarnessState(): Promise<HarnessStepDetail> {
	const harness = getHarnessService();
	const orcHarness = await harness.orc.get();
	if (!orcHarness) return { orcHarness: null, installed: false, loginState: null };
	// A runtime outside the harness list (crewly-agent, opencode…) is set up
	// elsewhere; setup has nothing to offer it.
	const def = isHarnessId(orcHarness) ? getHarnessDefinition(orcHarness) : undefined;
	if (!def) return { orcHarness, installed: true, loginState: 'unknown' };
	const installed = await harness.status.getInstalledInfo(def);
	if (!installed.installed) return { orcHarness, installed: false, loginState: null };
	const login = await harness.status.getLoginInfo(def, installed.path);
	return { orcHarness, installed: true, loginState: login.loginState };
}

/**
 * Hand a message to the orchestrator through the chat path.
 *
 * @param content - Message
 * @param metadata - Chat metadata
 * @returns Delivery result
 */
export async function sendViaChat(content: string, metadata: Record<string, unknown>): Promise<OrchestratorSendResult> {
	const { result, orchestrator } = await sendChatMessageToOrchestrator({ content, metadata });
	return {
		conversationId: result.conversation.id ?? null,
		forwarded: orchestrator.forwarded,
		queued: orchestrator.queued === true,
		error: orchestrator.error ?? null,
	};
}

/**
 * Real dependencies.
 *
 * @returns Dependencies backed by the backend's services
 */
export function createDefaultOnboardingDeps(): OnboardingChecklistDeps {
	return {
		store: new OnboardingStateStore(),
		getHarnessState: readOrcHarnessState,
		listTeams: () => StorageService.getInstance().getTeams(),
		saveTeam: (team) => StorageService.getInstance().saveTeam(team),
		templates: () => TemplateService.getInstance(),
		getOrcHarness: () => getHarnessService().orc.get(),
		hasOwnerMessage: () => getChatV2Service().getRecentOwnerMessageContents(0, 1).length > 0,
		getCloudState: () => {
			const cloud = CloudClientService.getInstance();
			const connected = cloud.isConnected();
			return { connected, tier: connected ? cloud.getTier() : null };
		},
		isSlackConnected: () => getSlackService().isConnected(),
		sendToOrchestrator: sendViaChat,
		now: () => new Date(),
	};
}

let instance: OnboardingChecklistService | null = null;

/**
 * The backend's onboarding checklist service.
 *
 * @returns The singleton
 */
export function getOnboardingChecklistService(): OnboardingChecklistService {
	if (!instance) instance = new OnboardingChecklistService(createDefaultOnboardingDeps());
	return instance;
}

/**
 * Replace or clear the singleton (tests).
 *
 * @param service - Service to use, or null to clear
 */
export function setOnboardingChecklistServiceForTesting(service: OnboardingChecklistService | null): void {
	instance = service;
}
