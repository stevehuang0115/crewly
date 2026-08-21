#!/usr/bin/env -S node --import tsx

import readline from 'node:readline';
import { AgentRunnerService } from './runtime/agent-runner.service.js';
import type {
  AgentRunResult,
  CrewlyAgentConfig,
  StreamingEventCallbacks,
} from './runtime/types.js';

type ParentMessage =
  | { type: 'init'; config: CrewlyAgentConfig }
  | { type: 'run'; runId?: string; message: string; conversationId?: string; metadata?: Record<string, string> }
  | { type: 'abort' }
  | { type: 'get-state' }
  | { type: 'shutdown' };

type WorkerMessage =
  | { type: 'ready' }
  // `runId` is echoed straight back from the `run` that produced it so the
  // parent can match a reply to its request. Without it the parent has to
  // guess, and guessing wrong books one conversation's answer against
  // another. Optional so an older parent that sends no id still works.
  | { type: 'result'; runId?: string; data: AgentRunResult }
  | { type: 'error'; runId?: string; error: string; code?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'stream'; event: 'text'; data: { chunk: string } }
  | { type: 'stream'; event: 'toolStart'; data: { toolName: string; args: Record<string, unknown> } }
  | { type: 'stream'; event: 'toolFinish'; data: { toolName: string; args: Record<string, unknown>; result: unknown; durationMs: number } }
  | { type: 'stream'; event: 'stepFinish'; data: { stepIndex: number; hasToolCalls: boolean } }
  | { type: 'state'; data: { historyLength: number; isProcessing: boolean; isInitialized: boolean } };

let runner: AgentRunnerService | null = null;
let currentAbort: AbortController | null = null;

function send(message: WorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(level: WorkerMessage extends { type: 'log'; level: infer L } ? L : never, message: string): void {
  send({ type: 'log', level: level as 'debug' | 'info' | 'warn' | 'error', message });
}

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

async function handleMessage(message: ParentMessage): Promise<void> {
  switch (message.type) {
    case 'init':
      try {
        runner = new AgentRunnerService(message.config);
        await runner.initialize();
        send({ type: 'ready' });
        log('info', `Initialized (${message.config.model.provider}/${message.config.model.modelId})`);
      } catch (error) {
        send({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          code: 'INIT_FAILED',
        });
        runner = null;
      }
      break;
    case 'run': {
      const { runId } = message;
      if (!runner || !runner.isInitialized()) {
        send({ type: 'error', runId, error: 'Worker not initialized', code: 'NOT_INITIALIZED' });
        return;
      }
      currentAbort = new AbortController();
      try {
        const result = await runner.run(
          message.message,
          message.conversationId,
          message.metadata,
          {
            abortSignal: currentAbort.signal,
            streaming: buildStreamingCallbacks(),
          },
        );
        currentAbort = null;
        send({ type: 'result', runId, data: result });
      } catch (error) {
        currentAbort = null;
        send({
          type: 'error',
          runId,
          error: error instanceof Error ? error.message : String(error),
          code: 'RUN_FAILED',
        });
      }
      break;
    }
    case 'abort':
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
      runner?.abortCurrentRun();
      log('warn', 'Run aborted by parent');
      break;
    case 'get-state':
      send({
        type: 'state',
        data: {
          historyLength: runner ? runner.getHistoryLength() : 0,
          isProcessing: runner ? runner.isProcessing() : false,
          isInitialized: runner ? runner.isInitialized() : false,
        },
      });
      break;
    case 'shutdown':
      log('info', 'Shutting down');
      if (runner) {
        await runner.shutdown();
        runner = null;
      }
      process.exit(0);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: ParentMessage;
  try {
    message = JSON.parse(trimmed) as ParentMessage;
  } catch {
    send({ type: 'error', error: `Invalid JSON input: ${trimmed}`, code: 'INVALID_JSON' });
    return;
  }

  handleMessage(message).catch((error) => {
    send({
      type: 'error',
      // Carry the correlation id here too — an unhandled failure must settle
      // the run it belongs to, not whichever run happens to be oldest.
      runId: message.type === 'run' ? message.runId : undefined,
      error: error instanceof Error ? error.message : String(error),
      code: 'UNHANDLED',
    });
  });
});

process.on('SIGINT', async () => {
  if (runner) {
    await runner.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (runner) {
    await runner.shutdown();
  }
  process.exit(0);
});

log('info', 'crewly-agent executable started');
