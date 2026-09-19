/**
 * Settings → Integrations (moved).
 *
 * Connections is its own page now. This tab stays because OAuth flows and
 * bookmarks still return to `/settings?tab=integrations` (and the Cloud
 * Slack install to `?tab=slack`): it forwards to `/connections`, carrying
 * the query across so the right card opens and `?slack=connected` /
 * `?google=connected` still land.
 *
 * @module components/Settings/IntegrationsTab
 */

import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';

/**
 * Build the `/connections` URL an old integrations link should land on.
 *
 * `?tab=slack` becomes `?platform=slack`; every other parameter (the
 * `…=connected` flags the connect UIs read) is carried over untouched.
 *
 * @param search - `window.location.search`
 * @returns The path to redirect to
 */
export function connectionsRedirectUrl(search: string): string {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  if (tab === 'slack' && !params.get('platform')) params.set('platform', 'slack');
  params.delete('tab');
  const qs = params.toString();
  return qs ? `/connections?${qs}` : '/connections';
}

/**
 * Forwards to the Connections page.
 *
 * @returns A one-line pointer (visible only if the redirect is blocked)
 */
export const IntegrationsTab: React.FC = () => {
  useEffect(() => {
    try {
      window.location.replace(connectionsRedirectUrl(window.location.search));
    } catch {
      // jsdom / locked-down browsers: the link below is the fallback.
    }
  }, []);

  return (
    <div className="space-y-4 max-w-3xl" data-testid="integrations-moved">
      <h2 className="text-xl font-semibold">Integrations moved</h2>
      <p className="text-sm text-text-secondary-dark">
        Messaging platforms and data connectors now live together on their own page.
      </p>
      <Link
        to="/connections"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors"
      >
        <Plug className="w-4 h-4" />
        Go to Connections
      </Link>
    </div>
  );
};

export default IntegrationsTab;
