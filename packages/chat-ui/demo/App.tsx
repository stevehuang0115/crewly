/**
 * Demo app — exercises @crewly/chat-ui against the mock client.
 *
 * The layout is deliberately minimal: sidebar (ChannelList) + thread
 * (MessageThread) + composer (MessageInput). It's the same layout both
 * OSS frontend and Portal will render, so visual bugs here show up in
 * production too.
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

export function DemoApp(): JSX.Element {
  const [active, setActive] = useState<Channel | null>(null);

  return (
    <ChatAPIProvider mode="mock">
      <div className="mx-auto flex h-screen max-w-6xl overflow-hidden bg-white shadow-lg dark:bg-slate-900">
        <ChannelList
          activeChannelId={active?.id ?? null}
          onSelectChannel={setActive}
        />

        <main className="flex flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <div>
              <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {active?.name ?? 'No channel selected'}
              </h1>
              {active?.purpose && (
                <p className="text-xs text-slate-500 dark:text-slate-400">{active.purpose}</p>
              )}
            </div>
            {active && (
              <AgentStatusBadge
                agentId={active.agentSession}
                channelId={active.id}
                status={active.presence}
              />
            )}
          </header>

          <div className="flex-1">
            <MessageThread channelId={active?.id ?? null} />
          </div>

          <MessageInput channelId={active?.id ?? null} />
        </main>
      </div>
    </ChatAPIProvider>
  );
}
