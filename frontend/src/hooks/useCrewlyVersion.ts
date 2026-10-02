/**
 * useCrewlyVersion — the running Crewly version for the sidebar / phone
 * "More" sheet, from `/health`.
 *
 * @module hooks/useCrewlyVersion
 */
import { useEffect, useState } from 'react';

/**
 * The running Crewly version, for the sidebar.
 *
 * `/health` already reports it along with whether a newer one is published,
 * so this needs no endpoint of its own. A failure is silent: the version is
 * a label, and a sidebar that will not render because a fetch failed would
 * be the worse trade.
 *
 * @returns The version and whether an update is available
 */
export function useCrewlyVersion(): { version: string | null; latestVersion: string | null; updateAvailable: boolean } {
	const [state, setState] = useState<{ version: string | null; latestVersion: string | null; updateAvailable: boolean }>({
		version: null,
		latestVersion: null,
		updateAvailable: false,
	});

	useEffect(() => {
		let cancelled = false;
		fetch('/health')
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				if (cancelled || !body || typeof body.version !== 'string') return;
				setState({
					version: body.version,
					latestVersion: typeof body.latestVersion === 'string' ? body.latestVersion : null,
					updateAvailable: body.updateAvailable === true,
				});
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	return state;
}
