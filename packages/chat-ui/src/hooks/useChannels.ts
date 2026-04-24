/**
 * useChannels — lists channels the current user has access to.
 *
 * Phase 1 scope: one-shot load + manual `refresh()`. No background polling;
 * the WS layer pushes new channels as presence/message events flow in on
 * a per-channel basis, so the sidebar stays fresh enough without polling.
 *
 * @module hooks/useChannels
 */

import { useCallback, useEffect, useState } from 'react';
import type { Channel } from '../types/chat.types';
import { useChatApiClient } from '../context/ChatAPIProvider';

export interface UseChannelsResult {
  channels: Channel[];
  loading: boolean;
  error: Error | null;
  refresh(): Promise<void>;
}

export function useChannels(): UseChannelsResult {
  const client = useChatApiClient();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.listChannels();
      setChannels(list);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return { channels, loading, error, refresh: load };
}
