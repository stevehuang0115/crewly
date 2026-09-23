/**
 * Terminal Component
 *
 * A React component that renders a terminal using xterm.js with real-time
 * WebSocket communication for PTY session interaction.
 *
 * @module Terminal
 */

import React, { useEffect, useCallback } from 'react';
import { useTerminalWebSocket } from './useTerminalWebSocket';
import { useXterm, TerminalTheme } from './useXterm';
import './Terminal.css';

/**
 * Props for the Terminal component.
 */
export interface TerminalProps {
	/** Name of the session to connect to */
	sessionName: string;
	/** Optional callback when terminal is ready */
	onReady?: () => void;
	/** Optional callback when connection is lost */
	onDisconnect?: () => void;
	/** Optional callback for connection errors */
	onError?: (error: string) => void;
	/** If true, terminal is read-only (no input) */
	readOnly?: boolean;
	/** Additional CSS class names */
	className?: string;
	/** Terminal theme (dark or light) */
	theme?: 'dark' | 'light';
	/** Font size in pixels */
	fontSize?: number;
	/** Show connection status header */
	showHeader?: boolean;
}

/** Dark terminal theme matching the app's dark mode */
const DARK_THEME: TerminalTheme = {
	background: '#111721',
	foreground: '#f6f7f8',
	cursor: '#2a73ea',
	cursorAccent: '#111721',
	selectionBackground: '#264f78',
	black: '#111721',
	red: '#ef4444',
	green: '#10b981',
	yellow: '#f59e0b',
	blue: '#2a73ea',
	magenta: '#8b5cf6',
	cyan: '#06b6d4',
	white: '#f6f7f8',
	brightBlack: '#313a48',
	brightRed: '#f87171',
	brightGreen: '#34d399',
	brightYellow: '#fbbf24',
	brightBlue: '#60a5fa',
	brightMagenta: '#a78bfa',
	brightCyan: '#22d3ee',
	brightWhite: '#ffffff',
};

/** Light terminal theme */
const LIGHT_THEME: TerminalTheme = {
	background: '#ffffff',
	foreground: '#1e1e1e',
	cursor: '#2a73ea',
	cursorAccent: '#ffffff',
	selectionBackground: '#add6ff',
	black: '#1e1e1e',
	red: '#dc2626',
	green: '#059669',
	yellow: '#d97706',
	blue: '#2563eb',
	magenta: '#7c3aed',
	cyan: '#0891b2',
	white: '#f3f4f6',
	brightBlack: '#4b5563',
	brightRed: '#ef4444',
	brightGreen: '#10b981',
	brightYellow: '#f59e0b',
	brightBlue: '#3b82f6',
	brightMagenta: '#8b5cf6',
	brightCyan: '#06b6d4',
	brightWhite: '#ffffff',
};

/**
 * Terminal component with xterm.js and WebSocket integration.
 *
 * Features:
 * - Real-time terminal rendering using xterm.js
 * - WebSocket-based communication with PTY backend
 * - Auto-resize using FitAddon
 * - Clickable URLs using WebLinksAddon
 * - Connection status indicator
 * - Read-only mode support
 *
 * @example
 * ```tsx
 * <Terminal
 *   sessionName="my-agent-session"
 *   onReady={() => console.log('Terminal ready')}
 *   onDisconnect={() => console.log('Disconnected')}
 * />
 * ```
 */
export const Terminal: React.FC<TerminalProps> = ({
	sessionName,
	onReady,
	onDisconnect,
	onError,
	readOnly = false,
	className = '',
	theme = 'dark',
	fontSize = 14,
	showHeader = true,
}) => {
	const termTheme = theme === 'dark' ? DARK_THEME : LIGHT_THEME;

	// Handle connection ready
	const handleConnect = useCallback(() => {
		onReady?.();
	}, [onReady]);

	// WebSocket hook
	const { sendInput, resize, connectionStatus, error } = useTerminalWebSocket({
		sessionName,
		onData: (data) => write(data),
		onRestore: (data) => {
			clear();
			write(data);
			scrollToBottom();
		},
		onConnect: handleConnect,
		onDisconnect,
		onError,
	});

	// Xterm hook
	const { terminalRef, isInitialized, write, clear, scrollToBottom } = useXterm({
		theme: termTheme,
		fontSize,
		readOnly,
		onInput: sendInput,
		onResize: resize,
	});

	// Re-fit terminal when session changes
	useEffect(() => {
		if (isInitialized) {
			const timeoutId = setTimeout(() => {
				// Trigger resize check
			}, 100);
			return () => clearTimeout(timeoutId);
		}
	}, [sessionName, isInitialized]);

	// Get status display info
	const getStatusInfo = () => {
		switch (connectionStatus) {
			case 'connected':
				return { color: 'bg-green-500', text: 'Connected' };
			case 'connecting':
				return { color: 'bg-yellow-500', text: 'Connecting...' };
			case 'reconnecting':
				return { color: 'bg-yellow-500', text: 'Reconnecting...' };
			case 'error':
				return { color: 'bg-red-500', text: 'Error' };
			case 'disconnected':
			default:
				return { color: 'bg-text-secondary-dark', text: 'Disconnected' };
		}
	};

	const statusInfo = getStatusInfo();

	return (
		<div className={`terminal-container ${className}`}>
			{showHeader && (
				<div className="terminal-header">
					<div className="terminal-header-left">
						<div className="terminal-dots">
							<div className="terminal-dot terminal-dot-red" />
							<div className="terminal-dot terminal-dot-yellow" />
							<div className="terminal-dot terminal-dot-green" />
						</div>
						<span className="terminal-title">{sessionName}</span>
					</div>
					<div className="terminal-header-right">
						<div className={`terminal-status-dot ${statusInfo.color}`} />
						<span className="terminal-status-text">{statusInfo.text}</span>
						{readOnly && <span className="terminal-readonly-badge">Read-only</span>}
					</div>
				</div>
			)}

			<div ref={terminalRef} className="terminal-content" />

			{!isInitialized && (
				<div className="terminal-loading">
					<div className="terminal-loading-spinner" />
					<span>Initializing terminal...</span>
				</div>
			)}

			{error && (
				<div className="terminal-error">
					<span>{error}</span>
				</div>
			)}
		</div>
	);
};

export default Terminal;
