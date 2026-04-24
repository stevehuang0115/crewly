/**
 * useSendMessage — a lightweight mutation hook for composer components
 * that don't own the message timeline state.
 *
 * `useMessages` already exposes a `sendMessage` bound to the active
 * channel; this hook is for surfaces that need a standalone action and
 * want the pending/error tracking. Example: a "Send" button in a banner
 * composer that sends into a specific channel without subscribing to
 * the thread.
 *
 * @module hooks/useSendMessage
 */

import { useCallback, useState } from 'react';
import type { Message, SendMessageInput } from '../types/chat.types';
import { useChatApiClient } from '../context/ChatAPIProvider';

export interface UseSendMessageResult {
  send(channelId: string, input: SendMessageInput): Promise<Message>;
  sending: boolean;
  error: Error | null;
  reset(): void;
}

export function useSendMessage(): UseSendMessageResult {
  const client = useChatApiClient();
  const [sending, setSending] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const send = useCallback(
    async (channelId: string, input: SendMessageInput) => {
      setSending(true);
      setError(null);
      try {
        return await client.sendMessage(channelId, input);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setSending(false);
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    setError(null);
    setSending(false);
  }, []);

  return { send, sending, error, reset };
}
