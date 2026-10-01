/**
 * POST /api/chat/reply — the single reply entry point behind the `reply`
 * skill (specs/2026-09-30-owner-message-guarantee.md §B).
 *
 * The agent says only what to answer; the harness sends it back where the
 * message it is answering came from (Slack DM, Slack room thread, portal /
 * Talk chat), over the right transport. Status markers still go to the
 * orchestrator; explicit ids that are the agent's own still win.
 *
 * @module controllers/chat/agent-reply.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { OrcReplyRouteService } from '../../services/orc/orc-reply-route.service.js';
import { isStatusReport, planAgentReply, type AgentReplyPlan } from '../../services/orc/agent-reply-target.js';
import {
  defaultWorkDestinationDeps,
  deliverToWorkDestination,
  planForSession,
  postNewThread,
  type WorkDestinationDeps,
} from '../../services/orc/work-item-destination.wiring.js';
import { parseSlackThreadKey } from '../../services/slack/slack-thread-key.js';
import { getOwnerMessageWatchdog } from '../../services/messaging/owner-message-watchdog.service.js';
import { LoggerService, type ComponentLogger } from '../../services/core/logger.service.js';
import { agentResponse, deliverAgentReplyToConversation, isAgentsOwnConversation } from './chat.controller.js';

const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('AgentReply');

/** Injectable collaborators (tests). */
export interface AgentReplyDeps {
  /** The status / orchestrator-chat path (`/api/chat/agent-response`). */
  agentResponse: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  deliver: typeof deliverAgentReplyToConversation;
  ownsConversation: (agentSession: string, conversationId: string) => Promise<boolean>;
  /** The orchestrator answering a Slack thread through the master bot. */
  postOrcSlack: (input: { channelId: string; threadTs?: string; text: string }) => Promise<string>;
  /** Work-item destinations (specs/2026-10-01-decision-cards.md §6) */
  workDestination: () => Promise<WorkDestinationDeps>;
}

/**
 * Default orchestrator Slack post: same send + bookkeeping as `/api/slack/send`.
 *
 * @param input - Channel, thread and text
 * @returns The Slack message ts
 */
async function defaultPostOrcSlack(input: { channelId: string; threadTs?: string; text: string }): Promise<string> {
  const { getSlackService } = await import('../../services/slack/slack.service.js');
  const slack = getSlackService();
  if (!slack.isConnected()) throw new Error('Slack is not connected');
  const ts = await slack.sendMessage({ channelId: input.channelId, text: input.text, ...(input.threadTs ? { threadTs: input.threadTs } : {}) });
  const { recordSlackReplyBookkeeping } = await import('../slack/slack.controller.js');
  await recordSlackReplyBookkeeping({
    channelId: input.channelId,
    threadTs: input.threadTs,
    senderSessionName: ORCHESTRATOR_SESSION_NAME,
    content: input.text,
    replyKind: 'text',
  });
  return ts;
}

const defaultDeps: AgentReplyDeps = {
  agentResponse,
  deliver: deliverAgentReplyToConversation,
  ownsConversation: isAgentsOwnConversation,
  postOrcSlack: defaultPostOrcSlack,
  workDestination: defaultWorkDestinationDeps,
};

/**
 * Build the handler.
 *
 * @param deps - Collaborators (defaults to the real ones)
 * @returns Express handler
 */
export function createAgentReplyHandler(deps: AgentReplyDeps = defaultDeps) {
  return async function agentReply(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const session = readAgentSessionHeader(req) ?? (typeof body.senderName === 'string' ? body.senderName : undefined);
      if (!session) {
        res.status(400).json({ success: false, error: 'Who is replying? Run the skill from an agent session (CREWLY_SESSION_NAME).' });
        return;
      }
      const none = body.none === true;
      const content = typeof body.content === 'string' ? body.content : '';
      if (!none && content.trim().length === 0) {
        res.status(400).json({ success: false, error: 'Reply text is required' });
        return;
      }
      const interim = body.interim === true;
      const requestedConv = typeof body.conversationId === 'string' ? body.conversationId : undefined;
      const requestedThread = typeof body.thread === 'string' ? body.thread : undefined;
      const isOrchestrator = session === ORCHESTRATOR_SESSION_NAME;
      const newThread = typeof body.newThread === 'string' ? body.newThread.trim() : '';

      // `reply --new-thread "<title>"`: an agent-initiated new topic.
      if (newThread && !none) {
        const delivered = isOrchestrator ? null : await postNewThread(session, newThread, content, await deps.workDestination());
        if (!delivered) {
          res.status(409).json({
            success: false,
            error: 'Could not start a new thread: you have no Slack team channel. Reply without --new-thread, or use slack-post with a channel.',
          });
          return;
        }
        logger.info('Agent started a new thread', { session, slackChannelId: delivered.slackChannelId, title: newThread });
        res.status(201).json({ success: true, data: { slackChannelId: delivered.slackChannelId, messageTs: delivered.messageTs, destination: delivered.kind } });
        return;
      }

      // No ids named: the answer follows the CURRENT work item's origin —
      // ticket thread, trigger destination, or a new top-level post — never
      // the thread the agent was last asked in (spec §6). The owner's fresh
      // message keeps the existing path below.
      if (!isOrchestrator && !none && !requestedConv && !requestedThread && !isStatusReport(content)) {
        const wd = await deps.workDestination();
        const { destination, workItem } = await planForSession(session, wd);
        if (destination.kind !== 'owner-origin') {
          try {
            const delivered = await deliverToWorkDestination(session, destination, content, wd);
            if (delivered) {
              logger.info('Agent reply sent to its work item destination', {
                session,
                workItemId: workItem?.id,
                destination: delivered.kind,
                slackChannelId: delivered.slackChannelId,
                threadTs: delivered.threadTs,
                reason: delivered.reason,
              });
              res.status(201).json({
                success: true,
                data: { slackChannelId: delivered.slackChannelId, messageTs: delivered.messageTs, threadTs: delivered.threadTs, destination: delivered.kind },
              });
              return;
            }
            logger.info('No Slack place for the work item destination — using the turn origin', { session, destination: destination.kind });
          } catch (err) {
            logger.warn('Work item destination post failed — using the turn origin', {
              session,
              destination: destination.kind,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const origin = OrcReplyRouteService.getInstance().getLastOrigin(session);
      const owns = requestedConv && !isOrchestrator ? await deps.ownsConversation(session, requestedConv) : false;

      const plan = planAgentReply({
        session,
        isOrchestrator,
        content,
        none,
        requested: { conversationId: requestedConv, thread: requestedThread },
        origin,
        ownsConversation: () => owns,
      });
      logReplyPlan(session, plan);

      switch (plan.kind) {
        case 'status': {
          req.body = { content, senderName: session, senderType: 'agent' };
          await deps.agentResponse(req, res, next);
          return;
        }
        case 'none': {
          const key = parseSlackThreadKey(plan.origin?.slackThreadKey);
          const closed =
            getOwnerMessageWatchdog()?.closeByAgent(session, {
              ...(plan.origin ? { chatChannelId: plan.origin.conversationId } : {}),
              ...(key ? { slackChannelId: key.slackChannelId, threadTs: key.threadTs } : {}),
            }) ?? 0;
          res.json({ success: true, data: { closed } });
          return;
        }
        case 'orc-chat': {
          req.body = {
            content,
            senderName: 'Orchestrator',
            senderType: 'orchestrator',
            ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
            ...(requestedConv ? { crossPost: body.crossPost === true } : {}),
          };
          await deps.agentResponse(req, res, next);
          return;
        }
        case 'orc-slack': {
          const ts = await deps.postOrcSlack({ channelId: plan.channelId, threadTs: plan.threadTs, text: content });
          res.json({ success: true, data: { slackChannelId: plan.channelId, threadTs: plan.threadTs, messageTs: ts } });
          return;
        }
        case 'post': {
          let messageId = await deps.deliver({ conversationId: plan.conversationId, thread: plan.thread, agentSession: session, content, interim });
          let conversationId = plan.conversationId;
          // Explicit ids that turned out not to work: the origin still does.
          if (!messageId && plan.via === 'explicit' && origin && origin.conversationId !== plan.conversationId) {
            messageId = await deps.deliver({
              conversationId: origin.conversationId,
              thread: origin.slackThreadKey ?? origin.chatThreadId,
              agentSession: session,
              content,
              interim,
            });
            conversationId = origin.conversationId;
          }
          if (!messageId) {
            logger.warn('Agent reply could not be delivered — told the agent (not filed as status)', {
              session,
              conversationId: plan.conversationId,
              thread: plan.thread,
            });
            res.status(409).json({
              success: false,
              error: `Could not post your reply into conversation ${plan.conversationId}. It was NOT delivered. Check you are a member there, or pass --conversation <id> from your prompt.`,
            });
            return;
          }
          res.status(201).json({ success: true, data: { messageId, conversationId } });
          return;
        }
        case 'no-target':
        default: {
          res.status(409).json({
            success: false,
            error: `Nothing to reply to: ${plan.kind === 'no-target' ? plan.reason : 'unknown'}. Pass --conversation <id> from your prompt.`,
          });
          return;
        }
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Log where a reply went and why (warn when it overrode the agent's ids).
 *
 * @param session - Replying agent
 * @param plan - The decision
 */
function logReplyPlan(session: string, plan: AgentReplyPlan): void {
  if (plan.kind === 'post' && plan.via === 'origin') {
    logger.info('Agent reply sent to the conversation its message came from', {
      session,
      conversationId: plan.conversationId,
      thread: plan.thread,
      reason: plan.reason,
    });
  } else {
    logger.debug('Agent reply plan', { session, plan: plan.kind });
  }
}

/** The handler with the real collaborators. */
export const agentReply = createAgentReplyHandler();
