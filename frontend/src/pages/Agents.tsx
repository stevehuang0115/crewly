/**
 * Agents page — first-class user ↔ agent direct chat surface.
 *
 * Mounts the shared `@crewly/chat-ui` package, which hosts the same React
 * components used by the Cloud Portal. Keeping the markup here deliberately
 * thin: every chat behavior lives in the shared package so the two surfaces
 * cannot drift.
 *
 * The orchestrator-pipe chat at `/chat` is a different product (see
 * `pages/Chat.tsx`); this page is the new Phase 1 Chat namespace
 * (`/api/chat/channels/*`, Sam's tech spec v1.0, §1).
 *
 * Mode selection:
 *  - `mock` (default, until Sam's backend ships) — exercises the UI + mock
 *    reply loop so we can iterate without waiting on endpoints.
 *  - `real` — wires `HttpChatApiClient` against the current origin; Vite
 *    dev proxy forwards `/api/*` and `/ws/*` to the OSS backend.
 *
 * Switch via `VITE_CHAT_MODE=real npm run dev` or by editing `.env.local`.
 *
 * @module pages/Agents
 */

import { useState } from 'react';
import {
  ChatAPIProvider,
  ChannelList,
  MessageThread,
  MessageInput,
  AgentStatusBadge,
  type Channel,
} from '@crewly/chat-ui';

/**
 * Resolve the chat-ui provider mode from Vite env at build/dev time.
 *
 * We default to `"mock"` so the page is usable the moment it ships, before
 * Sam's backend endpoints go live. Flip to `"real"` once the first endpoint
 * is up (Day 2 of Week 2).
 */
function resolveChatMode(): 'mock' | 'real' {
  const raw = (import.meta.env.VITE_CHAT_MODE ?? '').toString().toLowerCase();
  return raw === 'real' ? 'real' : 'mock';
}

/**
 * Resolve the backend URL for the chat-ui HTTP client.
 *
 * In dev and production the OSS frontend and backend share an origin
 * (Vite proxies `/api` and `/ws`), so `window.location.origin` is the
 * right base. An explicit override via `VITE_CHAT_BACKEND_URL` is available
 * for Cloud Pro scenarios where the backend lives on a different host.
 */
function resolveBackendURL(): string {
  const override = (import.meta.env.VITE_CHAT_BACKEND_URL ?? '').toString();
  if (override) return override.replace(/\/+$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

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
      <code className="font-mono">VITE_CHAT_MODE=real</code> to hit the
      live backend once it&apos;s up.
    </div>
  );
}

/**
 * Agents page component — 3-pane layout: channel list, message thread,
 * composer. Mirrors the demo app in `packages/chat-ui/demo/App.tsx` so
 * visual regressions in either surface are caught in the other.
 */
export const Agents: React.FC = () => {
  const mode = resolveChatMode();
  const backendURL = mode === 'real' ? resolveBackendURL() : undefined;
  const [active, setActive] = useState<Channel | null>(null);

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

        <div className="flex flex-1 overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-lg">
          <ChannelList
            activeChannelId={active?.id ?? null}
            onSelectChannel={setActive}
          />

          <main className="flex flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-text-primary-dark">
                  {active?.name ?? 'No channel selected'}
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
              <MessageThread channelId={active?.id ?? null} />
            </div>

            <MessageInput channelId={active?.id ?? null} />
          </main>
        </div>
      </div>
    </ChatAPIProvider>
  );
};

export default Agents;
