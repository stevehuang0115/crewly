/**
 * Agents page — first-class user ↔ agent direct chat surface.
 *
 * Renders a left rail of *agents* (discovered via `GET /api/chat/agents`)
 * rather than channels. Clicking an agent calls
 * `POST /api/chat/channels/dm/ensure` to find-or-create that agent's DM
 * channel, then mounts the shared `@crewly/chat-ui` thread + composer on
 * the resolved channel.
 *
 * Why agents not channels?
 *   Channels are an implementation detail — what the user thinks about is
 *   "which agent am I talking to right now?". The directory rail reads
 *   directly from the team file so every agent is reachable on first
 *   page-load, even before any chat has happened.
 *
 * Mode selection (kept from prior implementation):
 *   - `real` (default) — wires `HttpChatApiClient` against the current
 *     origin; Vite dev proxy forwards `/api/*` and `/ws/*` to the OSS
 *     backend. Set `VITE_CHAT_MODE=mock` to fall back to the in-memory
 *     stub when iterating without a backend.
 *
 * @module pages/Agents
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ChatAPIProvider,
  MessageThread,
  MessageInput,
  AgentStatusBadge,
  type Channel,
} from '@crewly/chat-ui';
import { AgentDirectory, type DirectoryAgent } from '../components/Chat/AgentDirectory';
import { resolveBackendURL, resolveChatMode } from '../utils/chat-backend';

/**
 * Small banner surfaced only when the page is running against the mock
 * client. Makes it obvious during demos / self-test that no real backend
 * is wired up.
 */
function MockModeBanner(): JSX.Element {
  return (
    <div
      className="mb-3 rounded-md border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
      role="note"
    >
      <span className="font-semibold">Mock mode:</span>{' '}
      messages are served from an in-memory stub. Set{' '}
      <code className="font-mono">VITE_CHAT_MODE=real</code> (default) to hit
      the live backend.
    </div>
  );
}

/**
 * POST `/api/chat/channels/dm/ensure` and return the resolved channel.
 * Throws on any non-2xx so the caller can surface a user-visible error.
 */
async function ensureDmChannel(agent: DirectoryAgent): Promise<Channel> {
  const res = await fetch('/api/chat/channels/dm/ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentSession: agent.agentSession,
      name: agent.name,
      purpose: `Direct chat with ${agent.name} (${agent.role})`,
    }),
  });
  type EnsureChannelResponse =
    | { success: true; data: Channel }
    | { success: false; error: { code: string; message: string } };
  const body = (await res.json()) as EnsureChannelResponse;
  if (body.success === false) {
    throw new Error(`Failed to open chat: ${body.error.message}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to open chat: HTTP ${res.status}`);
  }
  return body.data;
}

/**
 * Agents page component — 3-pane layout: agent directory, message thread,
 * composer. The directory replaces the chat-ui ChannelList so the user
 * sees agents directly (not channels) — a channel is silently created on
 * the first click.
 */
export const Agents: React.FC = () => {
  const mode = resolveChatMode();
  const backendURL = mode === 'real' ? resolveBackendURL() : undefined;
  const [active, setActive] = useState<Channel | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingAgentSession, setOpeningAgentSession] = useState<string | null>(
    null,
  );

  const handleSelectAgent = useCallback(
    async (agent: DirectoryAgent) => {
      setOpenError(null);
      setOpeningAgentSession(agent.agentSession);
      try {
        const channel = await ensureDmChannel(agent);
        setActive(channel);
      } catch (err) {
        setOpenError(err instanceof Error ? err.message : String(err));
      } finally {
        setOpeningAgentSession(null);
      }
    },
    [],
  );

  // Clear the error banner when the user successfully lands on a channel.
  useEffect(() => {
    if (active) setOpenError(null);
  }, [active]);

  return (
    <ChatAPIProvider mode={mode} backendURL={backendURL}>
      <div className="flex h-full flex-col px-4 py-3 md:px-6 md:py-4">
        <header className="mb-3">
          <h1 className="text-2xl font-semibold text-text-primary-dark">
            Agents
          </h1>
          <p className="text-sm text-text-secondary-dark">
            Direct chat with your agents. One channel per agent.
          </p>
        </header>

        {mode === 'mock' && <MockModeBanner />}
        {openError && (
          <div
            className="mb-3 rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
            role="alert"
          >
            {openError}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-lg">
          <AgentDirectory
            activeAgentSession={active?.agentSession ?? null}
            openingAgentSession={openingAgentSession}
            onSelectAgent={handleSelectAgent}
          />

          <main className="flex flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-text-primary-dark">
                  {active?.name ?? 'Select an agent to start chatting'}
                </h2>
                {active?.purpose && (
                  <p className="truncate text-xs text-text-secondary-dark">
                    {active.purpose}
                  </p>
                )}
              </div>
              {active && (
                <AgentStatusBadge
                  agentId={active.agentSession}
                  channelId={active.id}
                  status={active.presence}
                />
              )}
            </div>

            <div className="flex-1 overflow-hidden">
              <MessageThread
                channelId={active?.id ?? null}
                agentName={active?.name?.split('·')[0]?.trim() ?? active?.name}
              />
            </div>

            <MessageInput channelId={active?.id ?? null} />
          </main>
        </div>
      </div>
    </ChatAPIProvider>
  );
};

export default Agents;
