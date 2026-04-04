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

	res.json({
		...bridgeStatus,
		proxy: {
			state: proxy.getState(),
			available: proxy.isAvailable(),
			instances: proxy.getInstances(),
		},
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
 * Helper: send a tool command to the Chrome Extension and return the result.
 *
 * Tries three paths in order:
 * 1. Direct WebSocket (BrowserBridgeService) — fastest
 * 2. Browser Proxy (BrowserProxyService via Cloud Relay relay_to) — supports multi-instance
 * 3. Legacy relay adapter (BrowserRelayAdapter via CloudSync HTTP queue) — fallback
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

	// Path 1: If a specific instance is requested AND proxy is available, use proxy
	if (instance && proxy.isAvailable()) {
		try {
			const result = await proxy.sendCommand(tool, params, instance, timeoutMs, agentName);
			res.json(result);
			return;
		} catch (err) {
			res.status(504).json({
				success: false,
				error: (err as Error).message,
			});
			return;
		}
	}

	// Path 2: Direct WebSocket connection (fastest, no instance routing)
	if (bridge.isConnected()) {
		try {
			const result = await bridge.sendCommand(tool, params, timeoutMs, agentName);
			res.json(result);
			return;
		} catch (err) {
			res.status(504).json({
				success: false,
				error: (err as Error).message,
			});
			return;
		}
	}

	// Path 3: Proxy relay (relay_to addressed messaging)
	if (proxy.isAvailable()) {
		try {
			const result = await proxy.sendCommand(tool, params, instance, timeoutMs, agentName);
			res.json(result);
			return;
		} catch (err) {
			res.status(504).json({
				success: false,
				error: (err as Error).message,
			});
			return;
		}
	}

	// No path available
	res.status(503).json({
		success: false,
		error: 'No Chrome browser connected. Please connect the Crewly Chrome Extension first.',
		code: 'NO_BROWSER_CLIENT',
	});
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
