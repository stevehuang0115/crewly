/**
 * Feature map sync check (#811): the parsers on fixtures, then the real
 * `FEATURE_MAP.md` against the real router. A route added to or removed
 * from `src/App.tsx` or `LEGACY_REDIRECTS` without a map row fails here;
 * the failure message names the routes to add or remove.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
	FEATURE_MAP_OLD_URLS_HEADING,
	FEATURE_MAP_ROUTES_HEADING,
	diffRoutes,
	legacyRedirectPaths,
	markdownSection,
	routeTableRows,
	routesFromRouter,
} from './feature-map';

const FRONTEND_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(FRONTEND_ROOT, rel), 'utf8');

describe('routesFromRouter', () => {
	it('joins nested routes to their layout route and keeps top-level ones', () => {
		const src = `
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          {LEGACY_REDIRECTS.map((rule) => (
            <Route key={rule.path} path={rule.path} element={<LegacyRedirect rule={rule} />} />
          ))}
        </Route>
      </Routes>`;
		expect(routesFromRouter(src)).toEqual(['/auth', '/', '/projects', '/projects/:id']);
	});

	it('handles a layout under a prefix and multi-line Route tags', () => {
		const src = `
      <Route path="/admin" element={<Admin />}>
        <Route
          path="users"
          element={<Users />}
        />
        <Route index element={<Home />} />
      </Route>`;
		expect(routesFromRouter(src)).toEqual(['/admin', '/admin/users']);
	});
});

describe('legacyRedirectPaths', () => {
	it('reads the paths of the LEGACY_REDIRECTS array only', () => {
		const src = `
      export const OTHER = [{ path: 'nope' }];
      export const LEGACY_REDIRECTS: readonly LegacyRule[] = [
        { path: 'tasks', to: () => LINKS.requests() },
        { path: 'tasks/:id', to: ({ id }) => LINKS.request(id ?? '') },
      ];
      const after = { path: 'also-nope' };`;
		expect(legacyRedirectPaths(src)).toEqual(['/tasks', '/tasks/:id']);
	});

	it('returns nothing without the list', () => {
		expect(legacyRedirectPaths('export const ROUTES = {};')).toEqual([]);
	});
});

describe('markdownSection + routeTableRows', () => {
	const md = [
		'# Map',
		'',
		'## Routes',
		'',
		'| Route | Page | Job |',
		'| --- | --- | --- |',
		'| `/` | `src/pages/Dashboard.tsx` | home |',
		'| `/projects/:id` | `src/pages/ProjectDetail.tsx` | one project |',
		'',
		'## Old URLs',
		'',
		'| Old URL | Goes to |',
		'| --- | --- |',
		'| `/tasks` | `/tickets?tab=requests` |',
		'',
		'## Features',
		'| `/not-a-route` | prose table elsewhere |',
	].join('\n');

	it('reads the backticked first cells of the named section only', () => {
		expect(routeTableRows(markdownSection(md, FEATURE_MAP_ROUTES_HEADING))).toEqual([
			{ route: '/', target: 'src/pages/Dashboard.tsx' },
			{ route: '/projects/:id', target: 'src/pages/ProjectDetail.tsx' },
		]);
		expect(routeTableRows(markdownSection(md, FEATURE_MAP_OLD_URLS_HEADING))).toEqual([
			{ route: '/tasks', target: '/tickets?tab=requests' },
		]);
		expect(markdownSection(md, '## Missing')).toBe('');
	});
});

describe('diffRoutes', () => {
	it('names what each side lacks', () => {
		expect(diffRoutes(['/a', '/b'], ['/b', '/c'])).toEqual({ unmapped: ['/a'], stale: ['/c'] });
		expect(diffRoutes(['/a'], ['/a'])).toEqual({ unmapped: [], stale: [] });
	});
});

describe('FEATURE_MAP.md is in sync with the router', () => {
	const map = read('FEATURE_MAP.md');
	const routeRows = routeTableRows(markdownSection(map, FEATURE_MAP_ROUTES_HEADING));
	const oldRows = routeTableRows(markdownSection(map, FEATURE_MAP_OLD_URLS_HEADING));

	it('lists every static route of src/App.tsx, and nothing else', () => {
		const router = routesFromRouter(read('src/App.tsx'));
		expect(router.length).toBeGreaterThan(10);
		const diff = diffRoutes(router, routeRows.map((r) => r.route));
		expect(
			diff,
			`FEATURE_MAP.md "## Routes" is out of sync with src/App.tsx.\n` +
				`Add a row for: ${diff.unmapped.join(', ') || '(none)'}\n` +
				`Remove the row for: ${diff.stale.join(', ') || '(none)'}`,
		).toEqual({ unmapped: [], stale: [] });
	});

	it('lists every LEGACY_REDIRECTS old URL, and nothing else', () => {
		const legacy = legacyRedirectPaths(read('src/constants/routes.constants.ts'));
		expect(legacy.length).toBeGreaterThan(0);
		const diff = diffRoutes(legacy, oldRows.map((r) => r.route));
		expect(
			diff,
			`FEATURE_MAP.md "## Old URLs" is out of sync with LEGACY_REDIRECTS.\n` +
				`Add a row for: ${diff.unmapped.join(', ') || '(none)'}\n` +
				`Remove the row for: ${diff.stale.join(', ') || '(none)'}`,
		).toEqual({ unmapped: [], stale: [] });
	});

	it('names an existing page file for every route', () => {
		const missing = routeRows.filter((r) => !existsSync(path.join(FRONTEND_ROOT, r.target))).map((r) => `${r.route} → ${r.target}`);
		expect(missing, 'page files named in FEATURE_MAP.md that do not exist').toEqual([]);
	});

	it('has a Features section for each route table row', () => {
		const features = markdownSection(map, '## Features');
		const unmentioned = routeRows.map((r) => r.route).filter((route) => !features.includes(`\`${route}\``));
		expect(unmentioned, 'routes without a Features entry').toEqual([]);
	});
});
