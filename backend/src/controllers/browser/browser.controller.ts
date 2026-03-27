/**
 * Browser Controller
 *
 * REST API handlers for the Browser Bridge. Each handler translates an
 * HTTP request into a WebSocket command sent to the connected Chrome
 * Extension, waits for the response, and returns it as JSON.
 *
 * @module controllers/browser/browser.controller
 */

import type { Request, Response } from 'express';
import { BrowserBridgeService } from '../../services/browser/browser-bridge.service.js';

/**
 * GET /api/browser/status
 * Returns the current browser bridge connection status.
 *
 * @param _req - Express request (unused)
 * @param res - Express response
 */
export function getStatus(_req: Request, res: Response): void {
	const bridge = BrowserBridgeService.getInstance();
	res.json(bridge.getStatus());
}

/**
 * Helper: send a tool command to the Chrome Extension and return the result.
 * Handles the common pattern of forwarding a REST request to the WS bridge.
 * Extracts agent name from X-Agent-Session header if present.
 *
 * @param req - Express request (for extracting agent metadata)
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

	if (!bridge.isConnected()) {
		res.status(503).json({
			success: false,
			error: 'No Chrome browser connected. Please connect the Crewly Chrome Extension first.',
			code: 'NO_BROWSER_CLIENT',
		});
		return;
	}

	// Extract agent name: prefer explicit body/header name, fall back to session header.
	// Session names look like "crewly-product-max-118c0421" — extract "max" as friendly name.
	let agentName = (req.body?.agentName as string)
		|| (req.headers['x-agent-name'] as string)
		|| undefined;
	if (!agentName) {
		const session = req.headers['x-agent-session'] as string;
		if (session) {
			// Extract friendly name from session: "crewly-product-max-118c0421" → "max"
			const parts = session.split('-');
			if (parts.length >= 3) {
				agentName = parts[parts.length - 2]; // second-to-last part is the name
			} else {
				agentName = session;
			}
		}
	}

	try {
		const result = await bridge.sendCommand(tool, params, timeoutMs, agentName);
		res.json(result);
	} catch (err) {
		res.status(504).json({
			success: false,
			error: (err as Error).message,
		});
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
 * Execute JavaScript on the active tab.
 *
 * @param req - Express request with body { code: string }
 * @param res - Express response
 */
export async function execute(req: Request, res: Response): Promise<void> {
	await sendToolCommand(req, res, 'executeScript', { code: req.body.code });
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
