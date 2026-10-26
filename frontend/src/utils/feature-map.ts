/**
 * Feature map sync check — the parsers that compare `frontend/FEATURE_MAP.md`
 * with the router (#811, specs/2026-10-26-feature-map.md).
 *
 * The map is prose for agents; only its two route tables are machine-read:
 * the first cell of every row under `## Routes` and `## Old URLs`. The
 * router side is the static `<Route path=...>` JSX of `src/App.tsx` and the
 * `LEGACY_REDIRECTS` list of `src/constants/routes.constants.ts`. All
 * functions are pure (they take file contents); `feature-map.test.ts` reads
 * the real files and fails when the two sides disagree.
 *
 * @module utils/feature-map
 */

/** A row of a route table in the map: the route and the page file it names. */
export interface FeatureMapRow {
	/** Absolute route, e.g. `/tickets/runs/:id` */
	route: string;
	/** Second cell (the page file for Routes, the target for Old URLs) */
	target: string;
}

/** The heading of the table that lists the live routes. */
export const FEATURE_MAP_ROUTES_HEADING = '## Routes';
/** The heading of the table that lists the redirected old URLs. */
export const FEATURE_MAP_OLD_URLS_HEADING = '## Old URLs';

/**
 * The text of one `## ` section of a markdown document.
 *
 * @param markdown - The document
 * @param heading - The exact heading line, e.g. `## Routes`
 * @returns The section body (up to the next `## ` heading), or '' when absent
 */
export function markdownSection(markdown: string, heading: string): string {
	const lines = markdown.split('\n');
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start < 0) return '';
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^## /.test(l));
	return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * The rows of the first markdown table in a section whose first cell is a
 * backticked route (`| \`/path\` | target | ...`). The header and the
 * `| --- |` separator are skipped.
 *
 * @param section - Section text (see {@link markdownSection})
 * @returns Rows in document order
 */
export function routeTableRows(section: string): FeatureMapRow[] {
	const rows: FeatureMapRow[] = [];
	for (const line of section.split('\n')) {
		const m = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|/.exec(line.trim());
		if (!m) continue;
		rows.push({ route: m[1], target: m[2].replace(/^`|`$/g, '') });
	}
	return rows;
}

/**
 * The static routes a router file declares, as absolute paths.
 *
 * Reads `<Route path="..."` and `<Route index` attributes in order. A route
 * whose path starts with `/` is a top-level route; it also opens a layout
 * scope when its element wraps children (the tag does not self-close), so the
 * relative paths that follow are joined to it until the scope ends with
 * `</Route>`. Routes rendered from an expression (`path={rule.path}`) are not
 * static and are left out — see {@link legacyRedirectPaths}.
 *
 * @param source - Contents of `src/App.tsx`
 * @returns Absolute route paths, de-duplicated, in declaration order
 */
export function routesFromRouter(source: string): string[] {
	const out: string[] = [];
	const scopes: string[] = [];
	for (const tag of routeTags(source)) {
		if (tag.closing) {
			scopes.pop();
			continue;
		}
		const pathAttr = /\bpath="([^"]*)"/.exec(tag.attrs);
		const isIndex = /\bindex\b/.test(tag.attrs);
		let route: string | null = null;
		if (pathAttr) {
			const base = scopes[scopes.length - 1] ?? '';
			route = pathAttr[1].startsWith('/') ? pathAttr[1] : joinRoute(base, pathAttr[1]);
		} else if (isIndex) {
			route = scopes[scopes.length - 1] ?? '/';
		}
		if (route !== null && !out.includes(route)) out.push(route);
		if (!tag.selfClosing) scopes.push(route ?? scopes[scopes.length - 1] ?? '');
	}
	return out;
}

/** One `<Route ...>`, `<Route ... />` or `</Route>` tag of a router file. */
interface RouteTag {
	/** `</Route>` */
	closing: boolean;
	/** Ends with `/>` */
	selfClosing: boolean;
	/** The attribute text between `<Route` and the closing bracket */
	attrs: string;
}

/**
 * The Route tags of a JSX source, in order. Attribute values may hold JSX
 * (`element={<Users />}`), so the tag ends at the first `>` outside braces,
 * not at the first `>`.
 *
 * @param source - JSX source
 * @returns The tags in document order
 */
function routeTags(source: string): RouteTag[] {
	const tags: RouteTag[] = [];
	const open = /<Route\b|<\/Route>/g;
	let m: RegExpExecArray | null;
	while ((m = open.exec(source)) !== null) {
		if (m[0] === '</Route>') {
			tags.push({ closing: true, selfClosing: false, attrs: '' });
			continue;
		}
		let depth = 0;
		let i = m.index + m[0].length;
		for (; i < source.length; i++) {
			const ch = source[i];
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			else if (ch === '>' && depth === 0) break;
		}
		const attrs = source.slice(m.index + m[0].length, i);
		tags.push({ closing: false, selfClosing: /\/\s*$/.test(attrs), attrs: attrs.replace(/\/\s*$/, '') });
		open.lastIndex = i + 1;
	}
	return tags;
}

/**
 * Join a layout route and a child path (`/` + `projects/:id` → `/projects/:id`).
 *
 * @param base - The enclosing layout route ('' or '/...')
 * @param child - The child's relative path
 * @returns The absolute route
 */
function joinRoute(base: string, child: string): string {
	const b = base.replace(/\/+$/, '');
	return `${b}/${child.replace(/^\/+/, '')}`;
}

/**
 * The old URLs `LEGACY_REDIRECTS` handles, as absolute paths.
 *
 * Reads every `path: '...'` inside the `LEGACY_REDIRECTS` array literal; the
 * rules are relative to the layout route `/`.
 *
 * @param source - Contents of `src/constants/routes.constants.ts`
 * @returns Absolute old URLs in declaration order
 */
export function legacyRedirectPaths(source: string): string[] {
	const start = source.indexOf('LEGACY_REDIRECTS');
	if (start < 0) return [];
	// The literal follows the `=`; the type annotation before it has its own `[]`.
	const assign = source.indexOf('=', start);
	if (assign < 0) return [];
	const open = source.indexOf('[', assign);
	if (open < 0) return [];
	let depth = 0;
	let end = open;
	for (; end < source.length; end++) {
		const ch = source[end];
		if (ch === '[') depth++;
		else if (ch === ']' && --depth === 0) break;
	}
	const body = source.slice(open, end);
	const out: string[] = [];
	const re = /\bpath:\s*'([^']+)'/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) out.push(joinRoute('/', m[1]));
	return out;
}

/** What one side lists and the other does not. */
export interface RouteDiff {
	/** In the router, missing from the map */
	unmapped: string[];
	/** In the map, no longer in the router */
	stale: string[];
}

/**
 * Compare the router's routes with the map's rows.
 *
 * @param routerRoutes - From {@link routesFromRouter} or {@link legacyRedirectPaths}
 * @param mapRoutes - The first cells of the map's table
 * @returns The two differences (both empty when in sync)
 */
export function diffRoutes(routerRoutes: readonly string[], mapRoutes: readonly string[]): RouteDiff {
	const router = new Set(routerRoutes);
	const map = new Set(mapRoutes);
	return {
		unmapped: routerRoutes.filter((r) => !map.has(r)),
		stale: mapRoutes.filter((r) => !router.has(r)),
	};
}
