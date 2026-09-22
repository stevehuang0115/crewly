/**
 * Browser Controller
 *
 * REST API handlers for Crewly in Chrome. Each handler translates an
 * HTTP request into a WebSocket command sent to the connected Chrome
 * Extension, waits for the response, and returns it as JSON.
 *
 * @module controllers/browser/browser.controller
 */

import type { Request, Response } from 'express';
import { BrowserBridgeService } from '../../services/browser/browser-bridge.service.js';
import { BrowserProxyService } from '../../services/browser/browser-proxy.service.js';
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { getBrowserSessions } from '../../services/browser/browser-session.service.js';
import { BROWSER_BRIDGE_CONSTANTS } from '../../constants.js';

/**
 * GET /api/browser/status
 * Returns the current Crewly in Chrome connection status,
 * including proxy relay state and available browser instances.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export function getStatus(_req: Request, res: Response): void {
	const bridge = BrowserBridgeService.getInstance();
	const proxy = BrowserProxyService.getInstance();
	const bridgeStatus = bridge.getStatus();

	// Transport-honest status (TRANSPORT-HONESTY + STATUS-DISTINCTION
	// invariants): `drivable` is the single canonical predicate
	// `proxy.isAvailable()` (relay socket connected AND >=1 browser in the
	// account's relay registry). `transport` names the only browser-drivable
	// transport so a caller can never mistake "cloud config socket connected"
	// for "a browser is drivable". `instances[].deviceId` is observability
	// only — it shows which device a browser is reachable from, never gating
	// routing.
	const instances = proxy.getInstances().map((i) => ({
		instanceId: i.instanceId,
		instanceName: i.instanceName,
		...(i.deviceId ? { deviceId: i.deviceId } : {}),
	}));

	res.json({
		...bridgeStatus,
		transport: 'cloud-relay-ws',
		drivable: proxy.isAvailable(),
		proxy: {
			state: proxy.getState(),
			available: proxy.isAvailable(),
			deviceId: proxy.getDeviceId(),
			instances: proxy.getInstances(),
		},
		instances,
	});
}

/**
 * GET /api/browser/instances
 * List all connected browser instances available for command routing.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export function getInstances(_req: Request, res: Response): void {
	const bridge = BrowserBridgeService.getInstance();
	const proxy = BrowserProxyService.getInstance();

	// Combine direct WS clients and relay proxy instances
	const directClients = bridge.getStatus().clientCount;
	const proxyInstances = proxy.getInstances();

	res.json({
		success: true,
		instances: proxyInstances,
		directClientCount: directClients,
		proxyConnected: proxy.isConnected(),
	});
}

/**
 * POST /api/browser/proxy/connect
 * Manually connect the BrowserProxyService to the Cloud Relay.
 * Uses the current CloudClientService token. Call this when the proxy
 * is disconnected but the cloud connection is active.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export async function connectProxy(_req: Request, res: Response): Promise<void> {
	const proxy = BrowserProxyService.getInstance();

	if (proxy.isConnected()) {
		res.json({
			success: true,
			message: 'Proxy already connected',
			state: proxy.getState(),
			instances: proxy.getInstances(),
		});
		return;
	}

	try {
		const cloudClient = CloudClientService.getInstance();
		const token = cloudClient.getToken();

		if (!token) {
			res.status(400).json({
				success: false,
				error: 'No cloud token available. Connect to Cloud first via /api/cloud/connect.',
			});
			return;
		}

		// Ensure token resolver is wired up (idempotent — safe to call multiple times)
		proxy.setTokenResolver(() => cloudClient.getToken());

		proxy.connect(token);

		// Wait a moment for the WS connection + registration to complete
		await new Promise((resolve) => setTimeout(resolve, 3000));

		res.json({
			success: true,
			message: 'Proxy connecting to Cloud Relay',
			state: proxy.getState(),
			instances: proxy.getInstances(),
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: (err as Error).message,
		});
	}
}

/**
 * Extract the target browser instance from the request query or body.
 *
 * @param req - Express request
 * @returns Instance name/ID string or undefined for auto-select
 */
function resolveInstanceParam(req: Request): string | undefined {
	return (req.query.instance as string)
		|| (req.body?.instance as string)
		|| undefined;
}

/**
 * Extract the agent name from request headers or body.
 * Session names look like "crewly-product-max-118c0421" — extracts "max".
 *
 * @param req - Express request
 * @returns Agent name string or undefined
 */
function extractAgentName(req: Request): string | undefined {
	let agentName = (req.body?.agentName as string)
		|| (req.headers['x-agent-name'] as string)
		|| undefined;
	if (!agentName) {
		const session = req.headers['x-agent-session'] as string;
		if (session) {
			const parts = session.split('-');
			if (parts.length >= 3) {
				agentName = parts[parts.length - 2];
			} else {
				agentName = session;
			}
		}
	}
	return agentName;
}

/**
 * Extract the agent session id from headers/body (`X-Agent-Session` or
 * `agentSession` body field). Used to look up per-tab bindings.
 *
 * @param req Express request
 * @returns The session string when present, else `undefined`
 */
function extractAgentSession(req: Request): string | undefined {
	const fromHeader = req.headers['x-agent-session'];
	if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
	const fromBody = (req.body as { agentSession?: unknown } | undefined)?.agentSession;
	if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
	return undefined;
}

/**
 * Cross-agent ownership guard for the explicit `tabId` override path.
 *
 * Per spec §13.5: if a request supplies an explicit `tabId` that is bound
 * to a DIFFERENT agentSession, reject with 403. Without this check an agent
 * could forge a tabId in body and steal another agent's tab. We check the
 * raw `req.body.tabId` (not the per-handler `params`) because individual
 * handlers may strip or rename fields when projecting body → params.
 *
 * Returns the validated tabId so callers can fold it into params after
 * the check passes.
 *
 * @returns `{ ok: true, tabId? }` when the request should proceed (tabId
 *   present and owned, or absent). `{ ok: false }` when the response has
 *   been written with a 403 — caller should return.
 */
function resolveAndAuthorizeTabId(
	bridge: BrowserBridgeService,
	agentSession: string | undefined,
	req: Request,
	res: Response
): { ok: true; tabId?: number } | { ok: false } {
	const raw = (req.body as { tabId?: unknown } | undefined)?.tabId;
	if (raw === undefined || raw === null) return { ok: true };
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		// Non-numeric tabId in body — silently ignore (best-effort, matches
		// pre-M2 behaviour of forwarding the body verbatim).
		return { ok: true };
	}

	for (const binding of bridge.listBindings()) {
		if (binding.tabId === raw && binding.agentSession !== agentSession) {
			res.status(403).json({
				success: false,
				error: 'tab_owned_by_other_agent',
				details: `tabId ${raw} is bound to a different agent session`,
			});
			return { ok: false };
		}
	}
	return { ok: true, tabId: raw };
}

/**
 * Helper: send a tool command to the Chrome Extension and return the result.
 *
 * Tries three paths in order:
 * 1. Direct WebSocket (BrowserBridgeService) — fastest. When the request
 *    carries an `X-Agent-Session` header (or body.agentSession), routing
 *    flows through `BrowserBridgeService.sendCommandForAgent`, which auto-
 *    binds a fresh tab on first use and injects the bound `tabId` on every
 *    subsequent command. See §3.2 / §4.2 of the per-tab fix spec.
 * 2. Browser Proxy (BrowserProxyService via Cloud Relay relay_to) — supports
 *    multi-instance. NOT yet per-tab aware (deferred to v2).
 * 3. Legacy relay adapter (BrowserRelayAdapter via CloudSync HTTP queue) —
 *    fallback. Same deferral as Path 2.
 *
 * Supports `?instance=` query param for targeting a specific browser instance.
 *
 * @param req - Express request (for extracting agent metadata and instance param)
 * @param res - Express response object
 * @param tool - Chrome Extension tool name
 * @param params - Tool parameters
 * @param timeoutMs - Optional command timeout
 */
async function sendToolCommand(
	req: Request,
	res: Response,
	tool: string,
	params?: Record<string, unknown>,
	timeoutMs?: number
): Promise<void> {
	const bridge = BrowserBridgeService.getInstance();
	const proxy = BrowserProxyService.getInstance();
	const instance = resolveInstanceParam(req);
	const agentName = extractAgentName(req);
	const agentSession = extractAgentSession(req);

	// Per-tab ownership: explicit `tabId` in body must belong to this agent.
	// When the check passes and a tabId was present, fold it into params so
	// the bridge sees the override (handlers commonly strip body fields when
	// projecting body → params).
	const tabIdAuth = resolveAndAuthorizeTabId(bridge, agentSession, req, res);
	if (!tabIdAuth.ok) return;
	if (tabIdAuth.tabId !== undefined) {
		params = { ...(params ?? {}), tabId: tabIdAuth.tabId };
	}

	// Who holds the wheel, and is this something the agent may do alone?
	//
	// This sits ahead of every transport path on purpose. The guards that
	// decide whether an agent may send a message or submit a form all live at
	// the skill layer, and driving a browser goes around every one of them —
	// at this layer "send the email" is a click, shaped exactly like any
	// other click. An owner asked for an email to be drafted and the agent
	// sent it; nothing in the system was in a position to notice.
	if (agentSession) {
		const verdict = getBrowserSessions().authorize(agentSession, tool, params);
		if (!verdict.allow) {
			res.status(409).json({
				success: false,
				error: verdict.reason,
				code: verdict.code,
				...(verdict.pendingId ? { pendingId: verdict.pendingId } : {}),
			});
			return;
		}
	}

	// Collect errors from each path for diagnostics if all fail
	const errors: string[] = [];

	// Path 1: If a specific instance is requested AND proxy is available, use proxy
	if (instance && proxy.isAvailable()) {
		try {
			const result = await proxy.sendCommand(tool, params, instance, timeoutMs, agentName, agentSession);
			noteBrowserSessionAction(agentSession, tool, params, agentName, req);
			res.json(result);
			return;
		} catch (err) {
			errors.push(`proxy(instance=${instance}): ${(err as Error).message}`);
			// Fall through to try other paths
		}
	}

	// Path 2: Direct WebSocket connection (fastest, no instance routing).
	// Per-tab dispatch flows through here when an agentSession is present.
	if (bridge.isConnected()) {
		try {
			const result = agentSession
				? await bridge.sendCommandForAgent(agentSession, tool, params, timeoutMs, agentName)
				: await bridge.sendCommand(tool, params, timeoutMs, agentName);
			noteBrowserSessionAction(agentSession, tool, params, agentName, req);
			res.json(result);
			return;
		} catch (err) {
			errors.push(`direct-ws: ${(err as Error).message}`);
			// Fall through to try proxy path
		}
	}

	// Path 3: Proxy relay (relay_to addressed messaging)
	if (proxy.isAvailable()) {
		try {
			const result = await proxy.sendCommand(tool, params, instance, timeoutMs, agentName, agentSession);
			noteBrowserSessionAction(agentSession, tool, params, agentName, req);
			res.json(result);
			return;
		} catch (err) {
			errors.push(`proxy-relay: ${(err as Error).message}`);
			// Fall through to error response
		}
	}

	// No path available or all paths failed
	const errorDetail = errors.length > 0
		? `All connection paths failed: ${errors.join('; ')}`
		: 'No Chrome browser connected. Please connect the Crewly Chrome Extension first.';
	res.status(503).json({
		success: false,
		error: errorDetail,
		code: 'NO_BROWSER_CLIENT',
	});
}

/**
 * Fold a successful browser action into the watchable session for its agent.
 *
 * Called from all three transport paths rather than from each handler, so a
 * tool added later is covered without anyone remembering to wire it up.
 * Deliberately fire-and-forget and never throwing: the agent's command has
 * already succeeded, and a bookkeeping failure must not turn that into an
 * error response.
 *
 * @param agentSession - Owning agent session, when the caller sent one
 * @param tool - Tool that was dispatched
 * @param params - Params it was dispatched with
 * @param agentName - Display name for the UI, when sent
 * @param req - Request, read for the agent's stated goal
 */
function noteBrowserSessionAction(
	agentSession: string | undefined,
	tool: string,
	params: Record<string, unknown> | undefined,
	agentName: string | undefined,
	req: Request,
): void {
	if (!agentSession) return;
	try {
		const goalHeader = req.headers['x-agent-goal'];
		getBrowserSessions().noteAction({
			agentSession,
			tool,
			params,
			...(agentName ? { agentName } : {}),
			...(typeof goalHeader === 'string' && goalHeader ? { goal: goalHeader } : {}),
			...(typeof params?.tabId === 'number' ? { tabId: params.tabId } : {}),
		});
	} catch {
		// Never let session bookkeeping affect the agent's command.
	}
}

/**
 * POST /api/browser/navigate
 * Navigate the active tab to a URL.
 *
 * @param req - Express request with body { url: string }
 * @param res - Express response
 */
export async function navigate(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'navigate', { url: req.body.url });
}

/**
 * POST /api/browser/screenshot
 * Capture a screenshot of the active tab.
 *
 * @param _req - Express request
 * @param res - Express response
 */
export async function screenshot(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'screenshot');
}

/**
 * POST /api/browser/read-text
 * Read visible text from the active tab, optionally scoped to a selector.
 *
 * @param req - Express request with optional body { selector?: string }
 * @param res - Express response
 */
export async function readText(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'readText', req.body || {});
}

/**
 * GET /api/browser/tabs
 * List all open Chrome tabs.
 *
 * @param _req - Express request
 * @param res - Express response
 */
export async function getTabs(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'getTabs');
}

/**
 * POST /api/browser/execute
 * Execute a safe predefined operation on the active tab.
 * Supports: querySelectorAll, getTitle, getUrl, getSelection, getScrollPosition.
 *
 * @param req - Express request with body { operation: string, selector?: string }
 * @param res - Express response
 */
export async function execute(req: Request, res: Response): Promise<void> {
	const { operation, selector, code } = req.body || {};
	// Support legacy { code } param by mapping to executeJs tool
	if (code && !operation) {
		await sendToolCommand(req, res, 'executeJs', { code });
		return;
	}
	await sendToolCommand(req, res, 'executeScript', { operation, selector });
}

/**
 * POST /api/browser/execute-js
 * Execute arbitrary JavaScript code on the active tab.
 * Returns the serialized result.
 *
 * @param req - Express request with body { code: string }
 * @param res - Express response
 */
export async function executeJs(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'executeJs', { code: req.body?.code });
}

/**
 * POST /api/browser/click
 * Click an element by selector or coordinates.
 *
 * @param req - Express request with body { selector?: string, x?: number, y?: number }
 * @param res - Express response
 */
export async function click(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'click', req.body || {});
}

/**
 * POST /api/browser/fill
 * Fill a form field with a value.
 *
 * @param req - Express request with body { selector: string, value: string }
 * @param res - Express response
 */
export async function fill(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'fill', req.body || {});
}

/**
 * POST /api/browser/type
 * Type text into an element with optional delay.
 *
 * @param req - Express request with body { selector: string, text: string, delay?: number }
 * @param res - Express response
 */
export async function type(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'type', req.body || {});
}

/**
 * POST /api/browser/scroll
 * Scroll the page by direction/amount or to coordinates.
 *
 * @param req - Express request with body { direction?: string, amount?: number, x?: number, y?: number, selector?: string }
 * @param res - Express response
 */
export async function scroll(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'scroll', req.body || {});
}

/**
 * POST /api/browser/scroll-in-element
 * Scroll within a specific element.
 *
 * @param req - Express request with body { selector: string, direction?: string, amount?: number }
 * @param res - Express response
 */
export async function scrollInElement(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'scroll', req.body || {});
}

/**
 * POST /api/browser/hover
 * Hover over an element.
 *
 * @param req - Express request with body { selector: string }
 * @param res - Express response
 */
export async function hover(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'hover', req.body || {});
}

/**
 * POST /api/browser/press-key
 * Press a keyboard key with optional modifiers.
 *
 * @param req - Express request with body { key: string, modifiers?: string[] }
 * @param res - Express response
 */
export async function pressKey(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'pressKey', req.body || {});
}

/**
 * POST /api/browser/get-element
 * Get element information by selector.
 *
 * @param req - Express request with body { selector: string }
 * @param res - Express response
 */
export async function getElement(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'getElement', req.body || {});
}

/**
 * POST /api/browser/wait-for-selector
 * Wait for an element matching a selector to appear.
 *
 * @param req - Express request with body { selector: string, timeout?: number }
 * @param res - Express response
 */
export async function waitForSelector(req: Request, res: Response): Promise<void> {
	const timeout = req.body?.timeout;
	await sendToolCommand(req, res, 'waitForSelector', req.body || {}, timeout ? timeout + 5000 : undefined);
}

/**
 * GET /api/browser/cookies
 * Get cookies, optionally filtered by domain.
 *
 * @param req - Express request with optional query { domain?: string }
 * @param res - Express response
 */
export async function getCookies(req: Request, res: Response): Promise<void> {
	const params: Record<string, unknown> = {};
	if (req.query.domain) params.domain = req.query.domain;
	await sendToolCommand(req, res, 'getCookies', params);
}

/**
 * POST /api/browser/local-storage
 * Get local storage entries, optionally filtered by keys.
 *
 * @param req - Express request with optional body { keys?: string[] }
 * @param res - Express response
 */
export async function getLocalStorage(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'getLocalStorage', req.body || {});
}

/**
 * GET /api/browser/console
 * Get captured console messages, optionally clearing after read.
 *
 * @param req - Express request with optional query { clear?: string }
 * @param res - Express response
 */
export async function getConsole(req: Request, res: Response): Promise<void> {
	const params: Record<string, unknown> = {};
	if (req.query.clear === 'true') params.clear = true;
	await sendToolCommand(req, res, 'getConsoleMessages', params);
}

/**
 * POST /api/browser/full-page-screenshot
 * Capture a full-page screenshot.
 *
 * @param _req - Express request
 * @param res - Express response
 */
export async function fullPageScreenshot(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'fullPageScreenshot');
}

/**
 * POST /api/browser/get-interactive-elements
 * List interactive elements on the page.
 *
 * @param req - Express request with optional body { textContains?: string }
 * @param res - Express response
 */
export async function getInteractiveElements(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'getInteractiveElements', req.body || {});
}

/**
 * POST /api/browser/search-text
 * Search for text on the page.
 *
 * @param req - Express request with body { text: string, exact?: boolean }
 * @param res - Express response
 */
export async function searchText(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'searchText', req.body || {});
}

/**
 * POST /api/browser/list-options
 * List options in a select element.
 *
 * @param req - Express request with body { selector: string }
 * @param res - Express response
 */
export async function listOptions(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'listOptions', req.body || {});
}

/**
 * POST /api/browser/set-file-input
 * Set files on a file input element using CDP, bypassing the OS file picker.
 *
 * @param req - Express request with body { selector: string, filePaths: string[] }
 * @param res - Express response
 */
export async function setFileInput(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'setFileInput', req.body || {});
}

/**
 * POST /api/browser/select-option
 *
 * Select an option in a native HTML `<select>` element. CDP click on
 * a `<select>` does not open the dropdown (Chrome blocks synthetic
 * events on native form controls), and `<option>` children are rendered
 * by the OS rather than the DOM, so the existing `click` flow can't
 * reach them. This endpoint forwards to the extension's `selectOption`
 * tool, which sets `el.value` directly and dispatches `input` + `change`
 * events with `bubbles: true` so frameworks (React, Vue, etc.) pick the
 * change up via their controlled-component handlers.
 *
 * Selection precedence (one of these is required):
 *   - `value`  — match `<option>` by its `value` attribute
 *   - `label`  — match `<option>` by its visible text (`.text`)
 *   - `index`  — match `<option>` by zero-based position
 *
 * @param req - Express request with body
 *   `{ selector: string, value?: string, label?: string, index?: number,
 *      strategy?: "native" | "aria", tabId?: number }`
 * @param res - Express response — `{ success, selectedValue, selectedText }`
 *   on hit; `{ success: false, error }` on miss.
 */
export async function selectOption(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'selectOption', req.body || {});
}

// ---------------------------------------------------------------------------
// Per-tab dispatch (§4.2) — bind / unbind / list bindings
// ---------------------------------------------------------------------------

/**
 * POST /api/browser/bind
 *
 * Explicitly bind a fresh Chrome tab for the calling agent. The agent is
 * identified via the `X-Agent-Session` header (or `body.agentSession`).
 * Idempotent: if the agent already has a bound tab, returns the existing
 * binding without creating a new one.
 *
 * Body (all optional):
 *   - `active` (boolean, default false) — when true, the new tab is created
 *     in the foreground. Off by default to avoid disturbing the user.
 *
 * Responses:
 *   - 200 `{ success: true, data: { tabId, windowId?, bindingCount } }`
 *   - 400 `{ success: false, error: 'agent_session_required' }` when no
 *     `X-Agent-Session` header is supplied.
 *   - 503 `{ success: false, error: 'tab_pool_full', retryAfterMs }` when
 *     the hard cap (`CREWLY_TAB_BIND_MAX`, default 50) has been reached.
 *   - 503 `NO_BROWSER_CLIENT` when no Extension is connected.
 */
export async function bindTab(req: Request, res: Response): Promise<void> {
	const bridge = BrowserBridgeService.getInstance();
	const agentSession = extractAgentSession(req);
	if (!agentSession) {
		res.status(400).json({
			success: false,
			error: 'agent_session_required',
			details: 'X-Agent-Session header (or body.agentSession) is required for bind/unbind',
		});
		return;
	}

	if (!bridge.isConnected()) {
		res.status(503).json({
			success: false,
			error: 'No Chrome browser connected. Please connect the Crewly Chrome Extension first.',
			code: 'NO_BROWSER_CLIENT',
		});
		return;
	}

	const foreground = (req.body as { active?: unknown } | undefined)?.active === true;
	const agentName = extractAgentName(req);

	try {
		const binding = await bridge.bindAgentTab(agentSession, { foreground, agentName });
		res.json({
			success: true,
			data: {
				tabId: binding.tabId,
				windowId: binding.windowId,
				bindingCount: bridge.listBindings().length,
			},
		});
	} catch (err) {
		const code = (err as Error & { code?: string }).code;
		if (code === 'tab_pool_full') {
			res.status(503).json({
				success: false,
				error: 'tab_pool_full',
				details: (err as Error).message,
				retryAfterMs: BROWSER_BRIDGE_CONSTANTS.TAB_BIND_RETRY_AFTER_MS,
			});
			return;
		}
		res.status(502).json({
			success: false,
			error: 'bind_failed',
			details: (err as Error).message,
		});
	}
}

/**
 * POST /api/browser/unbind
 *
 * Release the calling agent's bound Chrome tab. Optionally tells the
 * Extension to close the tab (default true).
 *
 * Body (all optional):
 *   - `closeTab` (boolean, default true) — set to false to release the
 *     binding while leaving the tab alive (useful for handoff scenarios).
 *
 * Always returns 200 — `data.released:false` indicates "no binding existed",
 * which is not an error.
 */
export async function unbindTab(req: Request, res: Response): Promise<void> {
	const bridge = BrowserBridgeService.getInstance();
	const agentSession = extractAgentSession(req);
	if (!agentSession) {
		res.status(400).json({
			success: false,
			error: 'agent_session_required',
			details: 'X-Agent-Session header (or body.agentSession) is required for bind/unbind',
		});
		return;
	}

	const closeTab = (req.body as { closeTab?: unknown } | undefined)?.closeTab !== false;

	const result = await bridge.unbindAgentTab(agentSession, { closeTab });
	res.json({
		success: true,
		data: {
			released: result.released,
			tabClosed: result.tabClosed,
			bindingCount: bridge.listBindings().length,
		},
	});
}

/**
 * GET /api/browser/bindings
 *
 * Snapshot of all current agent→tab bindings. Used for diagnostics and
 * eventually for a UI panel showing which tab each running agent owns.
 *
 * Response: `{ success: true, data: { bindings: AgentTabBinding[], hardCap, softWarn } }`
 */
export function getBindings(_req: Request, res: Response): void {
	const bridge = BrowserBridgeService.getInstance();
	const bindings = bridge.listBindings();
	res.json({
		success: true,
		data: {
			bindings,
			hardCap: BROWSER_BRIDGE_CONSTANTS.TAB_BIND_HARD_CAP,
			softWarn: BROWSER_BRIDGE_CONSTANTS.TAB_BIND_SOFT_WARN,
		},
	});
}

// =============================================================================
// Live browser view
// =============================================================================

/**
 * GET /api/browser/sessions
 * List what each agent is doing in the browser right now.
 *
 * Returns metadata only. Frame bytes are fetched one at a time from
 * `/sessions/:id/frame`, so listing costs nothing and so fetching a picture
 * is an explicit, attributable act.
 *
 * @param req - Express request; `?active=1` hides finished sessions
 * @param res - Express response
 */
export function listBrowserSessions(req: Request, res: Response): void {
	const activeOnly = req.query.active === '1' || req.query.active === 'true';
	const sessions = getBrowserSessions().listSessions(!activeOnly);
	res.json({ success: true, data: { sessions } });
}

/**
 * GET /api/browser/sessions/:id
 * One agent's browser session.
 *
 * @param req - Express request with `:id` (the agent session name)
 * @param res - Express response
 */
export function getBrowserSession(req: Request, res: Response): void {
	const session = getBrowserSessions().getSession(req.params.id);
	if (!session) {
		res.status(404).json({ success: false, error: 'No browser session for that agent' });
		return;
	}
	res.json({ success: true, data: { session } });
}

/**
 * GET /api/browser/sessions/:id/frame
 * The most recent picture of the page the agent is on.
 *
 * Responds with the image itself rather than JSON so a plain `<img>` can
 * point at it. Fetching also registers the caller as a watcher, which is what
 * raises the capture rate — there is no separate subscribe call to get out of
 * sync, and interest expires on its own.
 *
 * Frames are owner-surface only: they are never persisted and never leave
 * this endpoint. Marked no-store so a picture of whatever the owner is logged
 * into does not linger in a disk cache or an intermediary.
 *
 * @param req - Express request with `:id`
 * @param res - Express response carrying image bytes, or 404
 */
export function getBrowserSessionFrame(req: Request, res: Response): void {
	const frame = getBrowserSessions().getFrame(req.params.id);
	if (!frame) {
		res.status(404).json({ success: false, error: 'No frame captured yet' });
		return;
	}
	const body = Buffer.from(frame.base64, 'base64');
	res.setHeader('Content-Type', frame.mimeType);
	res.setHeader('Cache-Control', 'no-store, private');
	res.setHeader('X-Frame-Captured-At', String(frame.capturedAt));
	res.send(body);
}

/**
 * GET /api/browser/sessions/:id/frame.json
 * The same frame, as JSON, for callers that cannot carry image bytes.
 *
 * The Cloud portal and the phone app reach this instance over the relay,
 * whose REST passthrough serialises everything as JSON. They cannot use the
 * raw-bytes route, so they get the same picture base64-encoded and pay the
 * ~33% for it — still tens of kilobytes, well inside the relay's frame
 * limit.
 *
 * Fetching registers a watcher exactly as the bytes route does, so a remote
 * viewer raises the capture rate the same way a local one does.
 *
 * @param req - Express request with `:id`
 * @param res - Express response
 */
export function getBrowserSessionFrameJson(req: Request, res: Response): void {
	const frame = getBrowserSessions().getFrame(req.params.id);
	if (!frame) {
		res.status(404).json({ success: false, error: 'No frame captured yet' });
		return;
	}
	res.setHeader('Cache-Control', 'no-store, private');
	res.json({
		success: true,
		data: {
			base64: frame.base64,
			mimeType: frame.mimeType,
			capturedAt: frame.capturedAt,
			...(frame.devicePixelRatio !== undefined ? { devicePixelRatio: frame.devicePixelRatio } : {}),
		},
	});
}

/**
 * POST /api/browser/sessions/:id/stop
 * Mark an agent's browser session as stopped by its owner.
 *
 * This ends the watchable session and its frames. It does not yet interrupt
 * the agent itself — taking the wheel away mid-action is a separate change
 * that needs the agent side to understand being pre-empted.
 *
 * @param req - Express request with `:id`
 * @param res - Express response
 */
export function stopBrowserSession(req: Request, res: Response): void {
	const sessions = getBrowserSessions();
	if (!sessions.getSession(req.params.id)) {
		res.status(404).json({ success: false, error: 'No browser session for that agent' });
		return;
	}
	sessions.endSession(req.params.id, 'stopped');
	res.json({ success: true, data: { session: sessions.getSession(req.params.id) } });
}

/**
 * POST /api/browser/sessions/:id/take-control
 * Take the wheel from the agent.
 *
 * While the owner holds it every browser call from that agent is refused, so
 * the two can never drive the same page at once — which matters most in
 * exactly the situation people take over for: typing a password.
 *
 * @param req - Express request with `:id`
 * @param res - Express response
 */
export function takeBrowserControl(req: Request, res: Response): void {
	const session = getBrowserSessions().takeControl(req.params.id);
	if (!session) {
		res.status(404).json({ success: false, error: 'No browser session for that agent' });
		return;
	}
	res.json({ success: true, data: { session } });
}

/**
 * POST /api/browser/sessions/:id/release-control
 * Give the wheel back to the agent.
 *
 * Tells the agent where the page ended up, because the owner has been
 * driving and it can no longer assume the page it last saw.
 *
 * @param req - Express request with `:id`
 * @param res - Express response
 */
export async function releaseBrowserControl(req: Request, res: Response): Promise<void> {
	const sessions = getBrowserSessions();
	const before = sessions.getSession(req.params.id);
	if (!before) {
		res.status(404).json({ success: false, error: 'No browser session for that agent' });
		return;
	}

	const session = sessions.releaseControl(req.params.id);
	await notifyAgentControlReturned(req.params.id, session?.url);
	res.json({ success: true, data: { session } });
}

/**
 * POST /api/browser/sessions/:id/pending/:pendingId
 * Approve or reject an action the agent was held on.
 *
 * Approval is one-shot: it lets the attempt the owner looked at through, and
 * nothing else. Approving does not replay the action — the agent retries,
 * because it is the one that knows what it was in the middle of.
 *
 * @param req - Express request with `:id`, `:pendingId` and body `{ decision }`
 * @param res - Express response
 */
export async function resolveBrowserPending(req: Request, res: Response): Promise<void> {
	const decision = (req.body as { decision?: string } | undefined)?.decision;
	if (decision !== 'approve' && decision !== 'reject') {
		res.status(400).json({ success: false, error: "decision must be 'approve' or 'reject'" });
		return;
	}

	const sessions = getBrowserSessions();
	const held = sessions.getSession(req.params.id)?.pending;
	const session = sessions.resolvePending(req.params.id, req.params.pendingId, decision);
	if (!session) {
		res.status(404).json({ success: false, error: 'No such pending action' });
		return;
	}

	await tellAgent(
		req.params.id,
		decision === 'approve'
			? `[BROWSER] The owner approved: ${held?.description ?? 'the action you were waiting on'}. Go ahead with exactly that, once.`
			: `[BROWSER] The owner declined: ${held?.description ?? 'the action you were waiting on'}. Do not do it, do not work around it. Say what you will do instead, or ask.`,
	);

	res.json({ success: true, data: { session } });
}

/**
 * Tell an agent that control has come back to it.
 *
 * The agent is not told what the owner did — only where the page is now,
 * which is all it needs and all we can honestly report. The owner may have
 * been typing a credential, and that is not ours to relay.
 *
 * @param agentSession - The agent getting control back
 * @param url - Where the page ended up, when known
 */
async function notifyAgentControlReturned(agentSession: string, url?: string): Promise<void> {
	await tellAgent(
		agentSession,
		`[BROWSER] The owner has finished and given control back to you. The page is now ${url ?? 'possibly somewhere else'}. Look at it before you act — do not assume it is where you left it.`,
	);
}

/** How this module reaches an agent to tell it something. */
export interface BrowserControlDeps {
	/** Deliver a line into an agent's session */
	sendMessageToAgent: (sessionName: string, message: string) => Promise<unknown>;
}

let controlDeps: BrowserControlDeps | null = null;

/**
 * Provide the way to reach agents.
 *
 * Injected from server startup rather than imported, because the agent
 * registration service is constructed with the server and importing it here
 * would be a cycle. Unset simply means the nudges are skipped.
 *
 * @param next - The dependencies, or null to clear them
 */
export function setBrowserControlDeps(next: BrowserControlDeps | null): void {
	controlDeps = next;
}

/**
 * Deliver a line into an agent's session, best-effort.
 *
 * Never allowed to throw: the owner's action has already been applied, and
 * failing to notify the agent must not turn a successful takeover into an
 * error the owner sees.
 *
 * @param agentSession - Target agent
 * @param message - What to tell it
 */
async function tellAgent(agentSession: string, message: string): Promise<void> {
	try {
		await controlDeps?.sendMessageToAgent(agentSession, message);
	} catch {
		// Best-effort: the UI is the owner's source of truth, not this nudge.
	}
}
