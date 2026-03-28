/**
 * Browser Routes
 *
 * Router configuration for Crewly in Chrome REST API endpoints.
 * These endpoints are called by the remote-browser skill to control
 * the user's Chrome browser via the WebSocket bridge.
 *
 * @module controllers/browser/browser.routes
 */

import { Router } from 'express';
import {
	getStatus,
	navigate,
	screenshot,
	readText,
	getTabs,
	execute,
	click,
	fill,
	type,
	scroll,
	scrollInElement,
	hover,
	pressKey,
	getElement,
	waitForSelector,
	getCookies,
	getLocalStorage,
	getConsole,
	fullPageScreenshot,
	getInteractiveElements,
	searchText,
	listOptions,
	setFileInput,
} from './browser.controller.js';

/**
 * Create the browser bridge router with all browser control endpoints.
 *
 * @returns Express router for /api/browser routes
 */
export function createBrowserRouter(): Router {
	const router = Router();

	// GET /api/browser/status — connection status
	router.get('/status', getStatus);

	// GET /api/browser/tabs — list open tabs
	router.get('/tabs', getTabs);

	// GET /api/browser/cookies — get cookies (optional ?domain=)
	router.get('/cookies', getCookies);

	// GET /api/browser/console — get console messages (optional ?clear=true)
	router.get('/console', getConsole);

	// POST /api/browser/navigate — navigate to URL
	router.post('/navigate', navigate);

	// POST /api/browser/screenshot — capture screenshot
	router.post('/screenshot', screenshot);

	// POST /api/browser/read-text — read page text
	router.post('/read-text', readText);

	// POST /api/browser/execute — execute JavaScript
	router.post('/execute', execute);

	// POST /api/browser/click — click element or coordinates
	router.post('/click', click);

	// POST /api/browser/fill — fill form field
	router.post('/fill', fill);

	// POST /api/browser/type — type text with delay
	router.post('/type', type);

	// POST /api/browser/scroll — scroll page
	router.post('/scroll', scroll);

	// POST /api/browser/scroll-in-element — scroll within element
	router.post('/scroll-in-element', scrollInElement);

	// POST /api/browser/hover — hover over element
	router.post('/hover', hover);

	// POST /api/browser/press-key — press keyboard key
	router.post('/press-key', pressKey);

	// POST /api/browser/get-element — get element info
	router.post('/get-element', getElement);

	// POST /api/browser/wait-for-selector — wait for element
	router.post('/wait-for-selector', waitForSelector);

	// POST /api/browser/local-storage — get local storage
	router.post('/local-storage', getLocalStorage);

	// POST /api/browser/full-page-screenshot — full page capture
	router.post('/full-page-screenshot', fullPageScreenshot);

	// POST /api/browser/get-interactive-elements — list interactive elements
	router.post('/get-interactive-elements', getInteractiveElements);

	// POST /api/browser/search-text — search for text on page
	router.post('/search-text', searchText);

	// POST /api/browser/list-options — list select options
	router.post('/list-options', listOptions);

	// POST /api/browser/set-file-input — set files on file input via CDP
	router.post('/set-file-input', setFileInput);

	return router;
}
