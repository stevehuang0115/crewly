/**
 * Sub-agents Controller
 *
 * `POST /api/subagents` runs one bounded in-process helper for the calling
 * agent and replies with its outcome (#1317). The `spawn-subagent` skill is
 * the caller; agents on Claude Code, Codex or Gemini get the same helper
 * the crewly-agent runtime has as a tool.
 *
 * @module controllers/subagents/subagents.controller
 */

import type { Request, Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import {
  getSubagentRunService,
  SubagentRunRefused,
  type SubagentRunInput,
} from '../../services/agent/crewly-agent/subagent-run.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SubagentsController');

/**
 * POST /api/subagents
 *
 * Body: `{ task, cwd, readOnly?, maxSteps?, model? }`. The parent is the
 * caller's agent session (X-Agent-Session); an owner or anonymous caller
 * gets 403. A refused request (nested, too many running, task too long,
 * bad cwd or model) is 400 with a `code`. Otherwise the reply waits for
 * the child — up to its wall-clock budget — and returns its outcome; a
 * child that failed or timed out is still 200, with `success: false` and
 * `stoppedReason`, because the parent reads it as evidence either way.
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function runSubagent(req: Request, res: Response): Promise<void> {
  const parent = readAgentSessionHeader(req);
  if (!parent) {
    res.status(403).json({
      success: false,
      code: 'parent_required',
      error: 'Only an agent session can spawn a sub-agent; the request carried no X-Agent-Session.',
    });
    return;
  }

  const body = (req.body ?? {}) as Partial<SubagentRunInput> & Record<string, unknown>;
  const input: SubagentRunInput = {
    task: typeof body.task === 'string' ? body.task : '',
    cwd: typeof body.cwd === 'string' ? body.cwd : '',
    readOnly: body.readOnly === true,
    ...(typeof body.maxSteps === 'number' ? { maxSteps: body.maxSteps } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
  };

  try {
    const outcome = await getSubagentRunService().run(parent, input);
    res.status(200).json({ success: true, data: outcome });
  } catch (error) {
    if (error instanceof SubagentRunRefused) {
      res.status(400).json({ success: false, code: error.code, error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Sub-agent run failed before it could report', { parent, error: message });
    res.status(500).json({ success: false, code: 'internal', error: message });
  }
}
