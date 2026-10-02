/**
 * useTabParam — keep a page's active tab in `?tab=` so every tab is linkable
 * (specs/2026-10-02-ui-redesign.md §Tabs). Pair with `<UnderlineTabs>`.
 *
 * - Unknown values fall back to the default tab (and `aliases` map old ids).
 * - The default tab is left out of the URL.
 * - Switching tabs replaces the history entry and keeps the other query
 *   parameters (filters, `?platform=`, OAuth flags).
 *
 * @module hooks/useTabParam
 */

import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Query parameter that holds the tab. */
export const TAB_PARAM = 'tab';

/**
 * Resolve a raw `?tab=` value.
 *
 * @param raw - Value from the URL (or null)
 * @param tabs - Valid tab ids; the first is the default
 * @param aliases - Old id → current id
 * @returns A valid tab id
 */
export function resolveTab<T extends string>(raw: string | null, tabs: readonly T[], aliases: Readonly<Record<string, T>> = {}): T {
	if (raw && (tabs as readonly string[]).includes(raw)) return raw as T;
	if (raw && aliases[raw]) return aliases[raw];
	return tabs[0];
}

/**
 * Active tab from the URL plus a setter.
 *
 * @param tabs - Valid tab ids; the first is the default
 * @param aliases - Old id → current id (e.g. `{ harness: 'runtimes' }`)
 * @returns `[tab, setTab]`
 *
 * @example
 * ```tsx
 * const [tab, setTab] = useTabParam(TICKETS_TABS);
 * <UnderlineTabs value={tab} onChange={(v) => setTab(v as TicketsTab)} tabs={…} />
 * ```
 */
export function useTabParam<T extends string>(
	tabs: readonly T[],
	aliases?: Readonly<Record<string, T>>,
): [T, (tab: T) => void] {
	const [searchParams, setSearchParams] = useSearchParams();
	const tab = resolveTab(searchParams.get(TAB_PARAM), tabs, aliases);

	const setTab = useCallback(
		(next: T) => {
			setSearchParams(
				(prev) => {
					const params = new URLSearchParams(prev);
					if (next === tabs[0]) params.delete(TAB_PARAM);
					else params.set(TAB_PARAM, next);
					return params;
				},
				{ replace: true },
			);
		},
		[setSearchParams, tabs],
	);

	return [tab, setTab];
}

export default useTabParam;
