/**
 * Agent Worker Process
 *
 * Standalone Node.js child process that wraps AgentRunnerService for
 * isolated agent execution. Communicates with the parent process via
 * IPC messages (Node.js child_process.fork() protocol).
 *
 * This enables hot-reload of agent code without restarting the main
 * backend process, and crash isolation so a worker failure doesn't
 * bring down the server.
 *
 * @module services/agent/crewly-agent/agent-worker
 */

import { AgentRunnerService } from './agent-runner.service.js';
import type {
  CrewlyAgentConfig,
  AgentRunResult,
  StreamingEventCallbacks,
} from './types.js';

// ===== IPC Message Types =====

/**
 * Messages sent from the parent process to this worker.
 */
export type ParentMessage =
  | { type: 'init'; config: CrewlyAgentConfig }
  | { type: 'run'; message: string; conversationId?: string; metadata?: Record<string, string> }
  | { type: 'abort' }
  | { type: 'get-state' }
  | { type: 'shutdown' };

/**
 * Messages sent from this worker to the parent process.
 */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; data: AgentRunResult }
  | { type: 'error'; error: string; code?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'stream'; event: 'text'; data: { chunk: string } }
  | { type: 'stream'; event: 'toolStart'; data: { toolName: string; args: Record<string, unknown> } }
  | { type: 'stream'; event: 'toolFinish'; data: { toolName: string; args: Record<string, unknown>; result: unknown; durationMs: number } }
  | { type: 'stream'; event: 'stepFinish'; data: { stepIndex: number; hasToolCalls: boolean } }
  | { type: 'state'; data: { historyLength: number; isProcessing: boolean; isInitialized: boolean } };

// ===== Worker State =====

let runner: AgentRunnerService | null = null;

/**
 * Send a typed message to the parent process.
 *
 * @param msg - Worker message to send
 */
function send(msg: WorkerMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

/**
 * Build streaming callbacks that forward events to the parent via IPC.
 *
 * @returns StreamingEventCallbacks that emit IPC messages
 */
function buildStreamingCallbacks(): StreamingEventCallbacks {
  return {
    onTextChunk: (chunk: string) => {
      send({ type: 'stream', event: 'text', data: { chunk } });
    },
    onToolCallStart: (toolName: string, args: Record<string, unknown>) => {
      send({ type: 'stream', event: 'toolStart', data: { toolName, args } });
    },
    onToolCallFinish: (toolName: string, args: Record<string, unknown>, result: unknown, durationMs: number) => {
      send({ type: 'stream', event: 'toolFinish', data: { toolName, args, result, durationMs } });
    },
    onStepFinish: (stepIndex: number, hasToolCalls: boolean) => {
      send({ type: 'stream', event: 'stepFinish', data: { stepIndex, hasToolCalls } });
    },
  };
}

/** AbortController for the currently executing run */
let currentAbort: AbortController | null = null;

/**
 * Handle incoming messages from the parent process.
 *
 * @param msg - Parent message received via IPC
 */
async function handleMessage(msg: ParentMessage): Promise<void> {
  switch (msg.type) {
    case 'init': {
      try {
        runner = new AgentRunnerService(msg.config);
        await runner.initialize();
        send({ type: 'ready' });
        send({ type: 'log', level: 'info', message: `Worker initialized (${msg.config.model.provider}/${msg.config.model.modelId})` });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', error: `Init failed: ${errMsg}`, code: 'INIT_FAILED' });
        runner = null;
      }
      break;
    }

    case 'run': {
      if (!runner || !runner.isInitialized()) {
        send({ type: 'error', error: 'Worker not initialized', code: 'NOT_INITIALIZED' });
        return;
      }

      currentAbort = new AbortController();
      const streamingCallbacks = buildStreamingCallbacks();

      try {
        const result = await runner.run(msg.message, msg.conversationId, msg.metadata, {
          abortSignal: currentAbort.signal,
          streaming: streamingCallbacks,
        });
        currentAbort = null;
        send({ type: 'result', data: result });
      } catch (err) {
        currentAbort = null;
        const errMsg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', error: errMsg, code: 'RUN_FAILED' });
      }
      break;
    }

    case 'abort': {
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
        send({ type: 'log', level: 'warn', message: 'Run aborted by parent' });
      }
      if (runner) {
        runner.abortCurrentRun();
      }
      break;
    }

    case 'get-state': {
      send({
        type: 'state',
        data: {
          historyLength: runner ? runner.getHistoryLength() : 0,
          isProcessing: runner ? runner.isProcessing() : false,
          isInitialized: runner ? runner.isInitialized() : false,
        },
      });
      break;
    }

    case 'shutdown': {
      send({ type: 'log', level: 'info', message: 'Worker shutting down' });
      if (runner) {
        await runner.shutdown();
        runner = null;
      }
      // Give IPC a moment to flush, then exit
      setTimeout(() => process.exit(0), 100);
      break;
    }
  }
}

// ===== Process Setup =====

// Listen for IPC messages from parent
process.on('message', (msg: ParentMessage) => {
  handleMessage(msg).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    send({ type: 'error', error: `Unhandled worker error: ${errMsg}`, code: 'UNHANDLED' });
  });
});

// Handle uncaught exceptions — report to parent before crashing
process.on('uncaughtException', (err) => {
  send({ type: 'error', error: `Worker crash (uncaughtException): ${err.message}`, code: 'CRASH' });
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  send({ type: 'error', error: `Worker crash (unhandledRejection): ${msg}`, code: 'CRASH' });
  setTimeout(() => process.exit(1), 100);
});

// Signal ready to receive init
send({ type: 'log', level: 'info', message: 'Agent worker process started, awaiting init' });
