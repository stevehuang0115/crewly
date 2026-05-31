/**
 * Shared resolution helpers for the `@crewly/chat-ui` HTTP client.
 *
 * The consolidated `/team-chat` surface mounts the chat-ui provider and needs
 * backend-URL + mode resolution. These helpers were originally inlined in the
 * (now-removed) `/agents` page; they live here so any chat surface shares a
 * single implementation rather than drifting apart.
 *
 * @module utils/chat-backend
 */

/**
 * Resolve the chat-ui provider mode from Vite env at build/dev time.
 *
 * Defaults to `"real"` so chat surfaces are wired to the live backend out of
 * the box. Set `VITE_CHAT_MODE=mock` in `.env.local` to fall back to the
 * in-memory stub while iterating on UI bits in isolation.
 *
 * @returns `"mock"` only when `VITE_CHAT_MODE` is explicitly `"mock"`, else `"real"`.
 */
export function resolveChatMode(): 'mock' | 'real' {
  const raw = (import.meta.env.VITE_CHAT_MODE ?? '').toString().toLowerCase();
  return raw === 'mock' ? 'mock' : 'real';
}

/**
 * Resolve the backend URL for the chat-ui HTTP client.
 *
 * In dev and production the OSS frontend and backend share an origin
 * (Vite proxies `/api` and `/ws`), so `window.location.origin` is the
 * right base. An explicit override via `VITE_CHAT_BACKEND_URL` is available
 * for Cloud Pro scenarios where the backend lives on a different host.
 *
 * @returns The trimmed override when set, else the current window origin, else `""`.
 */
export function resolveBackendURL(): string {
  const override = (import.meta.env.VITE_CHAT_BACKEND_URL ?? '').toString();
  if (override) return override.replace(/\/+$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}
