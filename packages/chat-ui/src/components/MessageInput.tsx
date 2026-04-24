/**
 * MessageInput — composer for the active channel.
 *
 * Shared package component: lives once here, imported by OSS frontend
 * and Portal.
 *
 * Supports:
 *  - Enter to send, Shift+Enter for newline
 *  - Drag-and-drop images (attachments are uploaded inline via data URLs
 *    in Phase 1; Sam's backend spec will confirm the upload contract)
 *  - Empty + whitespace-only input blocked
 *  - Sending state → disabled textarea + spinner label
 *
 * @module components/MessageInput
 */

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { MessageAttachment } from '../types/chat.types';
import { useSendMessage } from '../hooks/useSendMessage';

export interface MessageInputProps {
  channelId: string | null;
  placeholder?: string;
  /** Maximum pixel area to resize the textarea to before scrolling. */
  maxLines?: number;
  className?: string;
  /** Invoked after the server confirms the send. */
  onSent?(): void;
}

const DEFAULT_PLACEHOLDER = 'Message your agent — Enter to send, Shift+Enter for newline';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, matches a reasonable default.

export function MessageInput({
  channelId,
  placeholder = DEFAULT_PLACEHOLDER,
  className = '',
  onSent,
}: MessageInputProps): JSX.Element {
  const { send, sending, error } = useSendMessage();
  const [value, setValue] = useState<string>('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = useMemo(
    () => !!channelId && !sending && (value.trim().length > 0 || attachments.length > 0),
    [channelId, sending, value, attachments.length],
  );

  const handleSend = useCallback(async () => {
    if (!canSend || !channelId) return;
    const payload = { content: value.trim(), attachments: attachments.length ? attachments : undefined };
    try {
      await send(channelId, payload);
      setValue('');
      setAttachments([]);
      onSent?.();
    } catch {
      // `useSendMessage` captures the error into state; we surface it below.
    }
  }, [attachments, canSend, channelId, onSent, send, value]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    const imageFiles = files.filter((f) => f.type.startsWith('image/') && f.size <= MAX_IMAGE_BYTES);
    const encoded = await Promise.all(imageFiles.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...encoded]);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return (
    <div
      className={`border-t border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 ${className}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      data-testid="message-input"
    >
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Pending attachments">
          {attachments.map((a) => (
            <li key={a.id} className="relative">
              <img
                src={a.url}
                alt={a.filename ?? 'pending'}
                className="h-16 w-16 rounded object-cover"
              />
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className="absolute -right-1 -top-1 rounded-full bg-slate-900/80 px-1 text-[10px] leading-4 text-white"
                aria-label={`Remove ${a.filename ?? 'attachment'}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={!channelId || sending}
          placeholder={channelId ? placeholder : 'Select a channel to send a message.'}
          rows={2}
          className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-2 text-xs text-red-500">
          {error.message}
        </div>
      )}
    </div>
  );
}

/**
 * Encode a dropped file as a data URL for the local preview.
 *
 * WEEK 2 REFACTOR (orchestrator resolved 2026-04-24): the real backend
 * contract is a separate `POST /api/chat/attachments` that returns an
 * attachment id. When `ChatApiClient.uploadAttachment()` lands, this
 * function should:
 *   1. call `client.uploadAttachment(file)` → `{ id, url }`
 *   2. show the returned url in the preview (or fall back to the data URL
 *      while the upload is in flight)
 *   3. send the message with just the id, not the base64 payload
 * The mock client will continue to synthesize a local id so demo UX is
 * unchanged.
 */
async function fileToAttachment(file: File): Promise<MessageAttachment> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'image',
    url,
    filename: file.name,
    size: file.size,
    mimeType: file.type,
  };
}
