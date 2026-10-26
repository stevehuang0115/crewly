/**
 * reproduce-ui — open a dashboard feature by its feature-map entry and save
 * evidence (#811 slice 2, specs/2026-10-26-feature-map.md).
 *
 * Driven by execute.sh through environment variables:
 *   RU_ROUTE      route to open, e.g. `/tickets?tab=runs` (or RU_FEATURE)
 *   RU_FEATURE    a word of a Routes row of the map, resolved to its route
 *   RU_WAIT       CSS selector to wait for; default = the first data-testid
 *                 of the feature's Elements line in the map, else `body`
 *   RU_MAP        path of FEATURE_MAP.md (optional; lookups need it)
 *   RU_BASE_URL   dashboard origin, default CREWLY_API_URL
 *   RU_OUT        evidence root, default $CREWLY_HOME/evidence
 *   RU_TIMEOUT_MS how long to wait for the element (default 60000)
 *   RU_FULL_PAGE  "1" = full-page screenshot
 *   RU_BROWSER    path of a Chromium/Chrome executable (default: installed Chrome)
 *   RU_DRY_RUN    "1" = print the resolved plan as JSON and exit (no browser)
 *   RU_PKG_ROOT   Crewly package root (where playwright-core resolves from)
 *
 * Output: one JSON line on stdout — the plan (dry run) or the summary with the
 * evidence folder. Exit 0 when the element appeared, 2 when it did not (the
 * evidence is still written), 1 on a usage or launch error.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const env = process.env;

/**
 * How long to wait for navigation and for the element. The dashboard bundle
 * takes 20–40 s to render on a loaded machine (headless Chrome shares the
 * CPU with the agents), so a short default would report bugs that are not.
 */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Print a JSON error and exit.
 *
 * @param {string} message - What went wrong
 * @param {number} [code] - Exit code
 */
function fail(message, code = 1) {
	process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
	process.exit(code);
}

/**
 * The text of one `## ` section of a markdown document.
 *
 * @param {string} markdown - The document
 * @param {string} heading - The exact heading line
 * @returns {string} The section body, '' when absent
 */
export function markdownSection(markdown, heading) {
	const lines = markdown.split('\n');
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start < 0) return '';
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^## /.test(l));
	return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * The rows of the map's Routes table.
 *
 * @param {string} markdown - FEATURE_MAP.md
 * @returns {Array<{route: string, page: string, reach: string, job: string}>}
 */
export function routeRows(markdown) {
	const rows = [];
	for (const line of markdownSection(markdown, '## Routes').split('\n')) {
		const cells = line.trim().split('|').map((c) => c.trim());
		// A table row is `| a | b | c | d |` → ['', a, b, c, d, '']
		if (cells.length < 5 || !/^`\/.*`$/.test(cells[1])) continue;
		rows.push({ route: cells[1].replace(/`/g, ''), page: cells[2].replace(/`/g, ''), reach: cells[3], job: cells[4] ?? '' });
	}
	return rows;
}

/**
 * Resolve a feature word to one Routes row: an exact route, else the only
 * row whose route, page, reach or job contains the word (case-insensitive).
 *
 * @param {string} markdown - FEATURE_MAP.md
 * @param {string} feature - Route or word
 * @returns {{row?: object, candidates?: string[], error?: string}}
 */
export function resolveFeature(markdown, feature) {
	const rows = routeRows(markdown);
	const exact = rows.find((r) => r.route === feature);
	if (exact) return { row: exact };
	const needle = feature.toLowerCase();
	const hits = rows.filter((r) => [r.route, r.page, r.reach, r.job].some((c) => c.toLowerCase().includes(needle)));
	if (hits.length === 1) return { row: hits[0] };
	if (hits.length === 0) return { error: `no feature-map row matches "${feature}"`, candidates: rows.map((r) => r.route) };
	return { error: `"${feature}" matches several routes; pass --route`, candidates: hits.map((r) => r.route) };
}

/**
 * The data-testid to wait for on a route, from the Features section that
 * mentions it (its `**Elements**` line), as a CSS selector.
 *
 * A page with tabs lists its panel as `x-panel-${tab}`; with a `tab` the
 * placeholder is filled (`tickets-panel-runs`), which is the element that
 * proves the right tab rendered. Otherwise the first static id wins: `${…}`
 * ids are per-item, `a|b` lists variants, neither is one selector.
 *
 * @param {string} markdown - FEATURE_MAP.md
 * @param {string} route - Route pattern, e.g. `/tickets/runs/:id`
 * @param {string} [tab] - The `?tab=` value of the opened path
 * @returns {string|null} `[data-testid="x"]`, or null when none fits
 */
export function defaultWaitSelector(markdown, route, tab) {
	const features = markdownSection(markdown, '## Features');
	const blocks = features.split(/\n(?=### )/);
	const block = blocks.find((b) => b.split('\n')[0].includes(`\`${route}\``));
	if (!block) return null;
	const elements = block.split('\n').find((l) => l.includes('**Elements**'));
	if (!elements) return null;
	const ids = [...elements.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	if (tab) {
		const panel = ids.find((id) => id.includes('${tab}'));
		if (panel) return `[data-testid="${panel.replace('${tab}', tab)}"]`;
	}
	for (const id of ids) {
		if (id.includes('$') || id.includes('|') || /\s/.test(id)) continue;
		return `[data-testid="${id}"]`;
	}
	return null;
}

/**
 * The Routes row whose pattern matches an opened path (`/tickets/runs/abc`
 * → `/tickets/runs/:id`); an exact match wins, the query string is ignored.
 *
 * @param {Array<{route: string}>} rows - From {@link routeRows}
 * @param {string} path - Route or path, with or without `?tab=`
 * @returns {object|null} The row, or null
 */
export function matchRouteRow(rows, path) {
	const bare = path.split('?')[0].split('#')[0];
	const exact = rows.find((r) => r.route === bare);
	if (exact) return exact;
	return (
		rows.find((r) => {
			const re = new RegExp(`^${r.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+')}$`);
			return re.test(bare);
		}) ?? null
	);
}

/**
 * Turn a route pattern into an openable path: `:id` params need values.
 *
 * @param {string} route - Route or pattern
 * @param {Record<string,string>} params - RU_PARAM_<name> values
 * @returns {{path: string, missing: string[]}}
 */
export function fillRoute(route, params) {
	const missing = [];
	const path = route.replace(/:([A-Za-z_]+)/g, (_, name) => {
		const v = params[name];
		if (v === undefined) missing.push(name);
		return v === undefined ? `:${name}` : encodeURIComponent(v);
	});
	return { path, missing };
}

/**
 * A folder name for one run: `<utc-stamp>-<route slug>`.
 *
 * @param {string} route - The opened path
 * @param {Date} now - Clock
 * @returns {string}
 */
export function runFolderName(route, now) {
	const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const slug = route.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home';
	return `${stamp}-${slug.slice(0, 60)}`;
}

/**
 * The run plan from the environment (pure apart from reading the map file).
 *
 * @returns {object} plan
 */
export function buildPlan() {
	const mapPath = env.RU_MAP && existsSync(env.RU_MAP) ? env.RU_MAP : null;
	const map = mapPath ? readFileSync(mapPath, 'utf8') : null;
	let route = env.RU_ROUTE || '';
	let row = null;
	if (!route && env.RU_FEATURE) {
		if (!map) fail(`--feature needs the feature map; pass --map or --route (looked for ${env.RU_MAP || 'FEATURE_MAP.md'})`);
		const r = resolveFeature(map, env.RU_FEATURE);
		if (r.error) fail(`${r.error}${r.candidates?.length ? ` (routes: ${r.candidates.join(', ')})` : ''}`);
		row = r.row;
		route = row.route;
	} else if (route && map) {
		row = matchRouteRow(routeRows(map), route);
	}
	if (!route) fail('one of --route or --feature is required');
	if (!route.startsWith('/')) fail('--route must start with /');
	const params = {};
	for (const [k, v] of Object.entries(env)) if (k.startsWith('RU_PARAM_') && v) params[k.slice('RU_PARAM_'.length)] = v;
	const { path, missing } = fillRoute(route, params);
	if (missing.length) fail(`route ${route} needs a value for ${missing.map((m) => `--param ${m}=…`).join(', ')}`);
	const mapRoute = row?.route ?? route.split('?')[0];
	const tab = /[?&]tab=([^&#]+)/.exec(route)?.[1];
	const waitFor = env.RU_WAIT || (map ? defaultWaitSelector(map, mapRoute, tab ? decodeURIComponent(tab) : undefined) : null) || 'body';
	const baseUrl = (env.RU_BASE_URL || env.CREWLY_API_URL || `http://localhost:${env.WEB_PORT || 8787}`).replace(/\/+$/, '');
	const outRoot = env.RU_OUT || join(env.CREWLY_HOME || join(homedir(), '.crewly'), 'evidence');
	return {
		route,
		path,
		url: `${baseUrl}${path}`,
		waitFor,
		waitSource: env.RU_WAIT ? 'arg' : waitFor === 'body' ? 'default' : 'map',
		timeoutMs: Number(env.RU_TIMEOUT_MS) > 0 ? Number(env.RU_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
		fullPage: env.RU_FULL_PAGE === '1',
		map: mapPath,
		feature: row ? { page: row.page, reach: row.reach, job: row.job } : null,
		outRoot,
	};
}

/**
 * Load playwright-core from the Crewly package.
 *
 * @returns {import('playwright-core')}
 */
function loadPlaywright() {
	const root = env.RU_PKG_ROOT || resolve(process.cwd());
	try {
		const req = createRequire(join(root, 'package.json'));
		return req('playwright-core');
	} catch (e) {
		fail(`playwright-core is not available under ${root} (${e instanceof Error ? e.message : String(e)})`);
	}
}

/**
 * Run the plan in a headless browser and write the evidence.
 *
 * @param {object} plan - From {@link buildPlan}
 * @returns {Promise<number>} Exit code
 */
async function run(plan) {
	const started = Date.now();
	const debug = (m) => {
		if (env.RU_DEBUG === '1') process.stderr.write(`[reproduce-ui +${Date.now() - started}ms] ${m}\n`);
	};
	const pw = loadPlaywright();
	const dir = join(plan.outRoot, runFolderName(plan.path, new Date()));
	mkdirSync(dir, { recursive: true });
	const launch = plan.browser ? { executablePath: plan.browser } : { channel: 'chrome' };
	let browser;
	try {
		browser = await pw.chromium.launch({ headless: true, ...launch });
	} catch (e) {
		fail(`could not start a browser (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); install Google Chrome or pass --browser <path>`);
	}
	debug('browser launched');
	const console_ = [];
	const requests = [];
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') console_.push({ type: m.type(), text: m.text().slice(0, 500), at: Date.now() });
	});
	page.on('pageerror', (e) => console_.push({ type: 'pageerror', text: String(e.message ?? e).slice(0, 500), at: Date.now() }));
	page.on('requestfailed', (r) => requests.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText ?? 'failed' }));
	page.on('response', (r) => {
		if (r.status() >= 400) requests.push({ url: r.url(), method: r.request().method(), status: r.status() });
	});
	const t0 = Date.now();
	let navMs = null;
	let waitMs = null;
	let found = false;
	let navError = null;
	try {
		await page.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: plan.timeoutMs });
		navMs = Date.now() - t0;
		debug(`navigated in ${navMs}ms`);
		const t1 = Date.now();
		await page.waitForSelector(plan.waitFor, { state: 'visible', timeout: plan.timeoutMs });
		waitMs = Date.now() - t1;
		found = true;
		debug(`element in ${waitMs}ms`);
		await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
	} catch (e) {
		navError = e instanceof Error ? e.message.split('\n')[0] : String(e);
		debug(`stopped: ${navError}`);
	}
	const screenshot = join(dir, 'screenshot.png');
	try {
		await page.screenshot({ path: screenshot, fullPage: plan.fullPage, timeout: plan.timeoutMs });
	} catch {
		// A page that never rendered has nothing to shoot; the report says so.
	}
	debug('screenshot taken');
	const title = await page.title().catch(() => '');
	const finalUrl = page.url();
	await browser.close();
	debug('browser closed');

	const summary = {
		ok: found,
		route: plan.route,
		url: plan.url,
		finalUrl,
		title,
		waitFor: plan.waitFor,
		waitSource: plan.waitSource,
		found,
		error: navError,
		timings: { navigationMs: navMs, elementMs: waitMs, totalMs: Date.now() - t0 },
		consoleErrors: console_.length,
		failedRequests: requests.length,
		dir,
		screenshot: existsSync(screenshot) ? screenshot : null,
		feature: plan.feature,
	};
	writeFileSync(join(dir, 'console.json'), `${JSON.stringify(console_, null, 2)}\n`);
	writeFileSync(join(dir, 'requests.json'), `${JSON.stringify(requests, null, 2)}\n`);
	writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(join(dir, 'report.md'), renderReport(summary, console_, requests));
	process.stdout.write(`${JSON.stringify(summary)}\n`);
	return found ? 0 : 2;
}

/**
 * The human-readable report of one run.
 *
 * @param {object} s - Summary
 * @param {Array<object>} console_ - Console errors
 * @param {Array<object>} requests - Failed requests
 * @returns {string} Markdown
 */
export function renderReport(s, console_, requests) {
	const lines = [
		`# Reproduce: ${s.route}`,
		'',
		`- URL: ${s.url}${s.finalUrl && s.finalUrl !== s.url ? ` → ${s.finalUrl}` : ''}`,
		`- Title: ${s.title || '(none)'}`,
		`- Waited for: \`${s.waitFor}\` (${s.waitSource}) — ${s.found ? 'appeared' : `NOT found${s.error ? `: ${s.error}` : ''}`}`,
		`- Timings: navigation ${s.timings.navigationMs ?? '–'} ms, element ${s.timings.elementMs ?? '–'} ms, total ${s.timings.totalMs} ms`,
		`- Screenshot: ${s.screenshot ? 'screenshot.png' : '(none)'}`,
	];
	if (s.feature) lines.push(`- Feature: ${s.feature.job} — reached from ${s.feature.reach}; page \`${s.feature.page}\``);
	lines.push('', `## Console errors (${console_.length})`, '');
	lines.push(...(console_.length ? console_.map((c) => `- [${c.type}] ${c.text}`) : ['- none']));
	lines.push('', `## Failed requests (${requests.length})`, '');
	lines.push(...(requests.length ? requests.map((r) => `- ${r.method} ${r.url} → ${r.status ?? r.failure}`) : ['- none']));
	return `${lines.join('\n')}\n`;
}

if (env.RU_MAIN === '1') {
	const plan = buildPlan();
	plan.browser = env.RU_BROWSER || null;
	if (env.RU_DRY_RUN === '1') {
		process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, ...plan })}\n`);
	} else {
		run(plan).then((code) => process.exit(code));
	}
}
