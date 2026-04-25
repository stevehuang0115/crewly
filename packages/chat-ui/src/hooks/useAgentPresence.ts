/**
 * useAgentPresence — live presence for a single agent.
 *
 * Pattern: one REST call on mount for the initial snapshot, then a WS
 * subscription on the matching channel to keep the status fresh. When
 * the consumer doesn't have a channel context, the one-shot REST result
 * is returned and the hook does not subscribe.
 *
 * @module hooks/useAgentPresence
 */

import { useEffect, useState } from 'react';
import type { AgentPresenceStatus } from '../types/chat.types';
import { useChatApiClient } from '../context/ChatAPIProvider';

export interface UseAgentPresenceResult {
  status: AgentPresenceStatus;
  lastSeen?: string;
  loading: boolean;
  error: Error | null;
}

export function useAgentPresence(
  agentId: string | null,
  channelId?: string | null,
): UseAgentPresenceResult {
  const client = useChatApiClient();
  const [status, setStatus] = useState<AgentPresenceStatus>('offline');
  const [lastSeen, setLastSeen] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(!!agentId);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!agentId) {
      setStatus('offline');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getAgentPresence(agentId)
      .then((p) => {
        if (cancelled) return;
        setStatus(p.status);
        setLastSeen(p.lastSeen);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, client]);

  useEffect(() => {
    if (!agentId || !channelId) return;
    const sub = client.subscribeToChannel(channelId, (event) => {
      if (event.type === 'presence' && event.agentSession === agentId) {
        setStatus(event.status);
        setLastSeen(event.lastSeen);
      }
    });
    return () => sub.unsubscribe();
  }, [agentId, channelId, client]);

  return { status, lastSeen, loading, error };
}
