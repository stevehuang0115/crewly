import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Terminal as TerminalIcon, X, AlertCircle, Play } from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { useNavigate } from 'react-router-dom';
import { useTerminal } from '../../contexts/TerminalContext';
import { webSocketService } from '../../services/websocket.service';
import { Button, IconButton } from '../UI';

interface TerminalSession {
  id: string;
  name: string;
  displayName: string;
  type: 'orchestrator' | 'team_member';
  teamId?: string;
  memberId?: string;
  /** True for in-process Crewly Agent sessions (read-only log viewer) */
  isInProcess?: boolean;
}

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const { selectedSession, setSelectedSession } = useTerminal();
  const [availableSessions, setAvailableSessions] = useState<TerminalSession[]>([
    {
      id: 'crewly-orc',
      name: 'crewly-orc',
      displayName: 'Orchestrator',
      type: 'orchestrator'
    }
  ]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalPanelRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [xtermInitialized, setXtermInitialized] = useState(false);
  const currentSubscription = useRef<string | null>(null);
  const sessionSwitchTimeout = useRef<NodeJS.Timeout | null>(null);
  const sessionPendingRetryRef = useRef<NodeJS.Timeout | null>(null);
  const connectionCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const connectionCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const maxReconnectAttempts = 3;

  // Track which sessions are in-process (read-only log viewers)
  const inProcessSessionsRef = useRef<Set<string>>(new Set());

  // Smart scrolling: track if user has scrolled away from bottom
  const isUserScrolledUp = useRef<boolean>(false);

  // Swipe-to-close gesture tracking refs
  const touchStartXRef = useRef<number>(0);
  const touchStartYRef = useRef<number>(0);
  const touchDeltaXRef = useRef<number>(0);
  const isSwiping = useRef<boolean>(false);
  const [swipeOffset, setSwipeOffset] = useState(0);

  // Touch scroll detection refs (replaces wheel-only detection for mobile)
  const lastTouchYRef = useRef<number>(0);

  // Ref to track the current session for use in recursive timeouts
  // This prevents stale closures in the retry logic
  const selectedSessionRef = useRef<string>(selectedSession);

  // Keep the ref in sync with the state
  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  // Derived: is the currently selected session an in-process (read-only) session?
  const isCurrentSessionReadOnly = inProcessSessionsRef.current.has(selectedSession);

  /**
   * Check if the terminal is scrolled to the bottom (or within threshold).
   * Uses xterm's buffer to determine scroll position.
   */
  const isAtBottom = useCallback((): boolean => {
    if (!xtermRef.current) return true;
    const term = xtermRef.current;
    const buffer = term.buffer.active;
    // baseY is the scroll position from top, rows is visible rows
    // viewportY is the current viewport position
    // If viewportY + rows >= buffer length, we're at the bottom
    const viewportY = buffer.viewportY;
    const totalRows = buffer.length;
    const visibleRows = term.rows;
    // Allow a small threshold (2 lines) to account for partial scrolls
    return viewportY + visibleRows >= totalRows - 2;
  }, []);

  /**
   * Scrolls to bottom only if auto-scroll is enabled (user hasn't scrolled up).
   */
  const scrollToBottomIfEnabled = useCallback(() => {
    if (!isUserScrolledUp.current && xtermRef.current) {
      xtermRef.current.scrollToBottom();
    }
  }, []);

  /**
   * Clears all session-related timeouts to prevent memory leaks.
   * Should be called when switching sessions or cleaning up.
   */
  const clearSessionTimeouts = useCallback(() => {
    if (sessionSwitchTimeout.current) {
      clearTimeout(sessionSwitchTimeout.current);
      sessionSwitchTimeout.current = null;
    }
    if (sessionPendingRetryRef.current) {
      clearTimeout(sessionPendingRetryRef.current);
      sessionPendingRetryRef.current = null;
    }
  }, []);

  // Initialize xterm.js terminal - use useLayoutEffect to ensure DOM is ready
  useLayoutEffect(() => {
    // Only initialize when panel is open and not already initialized
    if (!isOpen || xtermInitialized) return;

    // Wait for container to be available
    const container = terminalContainerRef.current;
    if (!container) return;

    const isMobile = window.innerWidth < 640;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: isMobile ? 12 : 14,
      fontFamily: '"Fira Code", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#111721',
        foreground: '#f6f7f8',
        cursor: '#2a73ea',
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
      },
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(container);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle user input - use ref to always get current session.
    // Filter out terminal response sequences (DA1, DA2, DSR) that xterm.js
    // generates in response to queries from the child process. These responses
    // must NOT be sent to the PTY as they would appear as typed text in CLI
    // input lines (e.g. Gemini CLI shows "[?1;2c" in its prompt).
    const TERMINAL_RESPONSE_RE = /\x1b\[\??[\d;]*[cRn]|\x1b\[>[\d;]*c/g;
    term.onData((data) => {
      // Block input for in-process (read-only) sessions
      if (inProcessSessionsRef.current.has(selectedSessionRef.current)) {
        return;
      }
      if (webSocketService.isConnected() && selectedSessionRef.current) {
        const filtered = data.replace(TERMINAL_RESPONSE_RE, '');
        if (filtered.length > 0) {
          webSocketService.sendInput(selectedSessionRef.current, filtered);
        }
      }
    });

    // Smart scroll: re-enable auto-scroll when viewport reaches the bottom.
    // IMPORTANT: This handler ONLY re-enables auto-scroll. It must NOT disable it
    // (set isUserScrolledUp=true) because xterm's internal scroll events fire during
    // data writes when the viewport is momentarily not at the bottom. That would
    // falsely disable auto-scroll. Only the wheel handler (user interaction) disables it.
    const viewportElement = container.querySelector('.xterm-viewport');
    const handleScroll = () => {
      if (isAtBottom()) {
        isUserScrolledUp.current = false;
      }
    };

    if (viewportElement) {
      viewportElement.addEventListener('scroll', handleScroll);
    }

    // Also listen for mousewheel events to detect intentional user scrolling
    const handleWheel = (e: WheelEvent) => {
      // Only track upward scrolls (negative deltaY means scrolling up)
      if (e.deltaY < 0) {
        isUserScrolledUp.current = true;
      } else if (e.deltaY > 0 && isAtBottom()) {
        // User scrolled down and reached bottom
        isUserScrolledUp.current = false;
      }
    };
    container.addEventListener('wheel', handleWheel);

    // Touch scroll detection for mobile devices (wheel events don't fire on touch)
    const handleTouchStart = (e: TouchEvent) => {
      lastTouchYRef.current = e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0].clientY;
      const deltaY = lastTouchYRef.current - currentY; // positive = scrolling up in content
      lastTouchYRef.current = currentY;

      if (deltaY < 0) {
        // Finger moving down = scrolling up through content
        isUserScrolledUp.current = true;
      } else if (deltaY > 0 && isAtBottom()) {
        // Finger moving up = scrolling down, and we reached bottom
        isUserScrolledUp.current = false;
      }
    };
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        const dimensions = fitAddonRef.current.proposeDimensions();
        if (dimensions && selectedSessionRef.current) {
          webSocketService.resizeTerminal(selectedSessionRef.current, dimensions.cols, dimensions.rows);

          // Debounce the terminal state re-request (300ms after last resize)
          if (resizeStateRequestRef.current) {
            clearTimeout(resizeStateRequestRef.current);
          }
          resizeStateRequestRef.current = setTimeout(() => {
            if (selectedSessionRef.current) {
              webSocketService.requestTerminalState(selectedSessionRef.current);
            }
            resizeStateRequestRef.current = null;
          }, 300);
        }
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    setXtermInitialized(true);

    return () => {
      resizeObserver.disconnect();
      if (viewportElement) {
        viewportElement.removeEventListener('scroll', handleScroll);
      }
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      setXtermInitialized(false);
      isUserScrolledUp.current = false;
    };
  }, [isOpen, isAtBottom]);  // Only depend on isOpen - xterm init shouldn't depend on session loading

  // Handle panel opening animation - resize/fit terminal after transition completes
  useEffect(() => {
    if (isOpen && xtermInitialized && fitAddonRef.current && xtermRef.current) {
      // The panel has a 300ms transition (duration-300).
      // We need to wait for it to finish before fitting, otherwise dimensions are wrong.
      const timer = setTimeout(() => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const dimensions = fitAddonRef.current.proposeDimensions();
          if (dimensions && selectedSessionRef.current) {
            webSocketService.resizeTerminal(selectedSessionRef.current, dimensions.cols, dimensions.rows);
          }
        }
      }, 350); // 350ms to be safe (slightly longer than transition)

      return () => clearTimeout(timer);
    }
  }, [isOpen, xtermInitialized]);

  // Write terminal output to xterm, scrolling to bottom after data is processed
  const writeToXterm = useCallback((data: string) => {
    if (xtermRef.current) {
      xtermRef.current.write(data, () => {
        scrollToBottomIfEnabled();
      });
    }
  }, [scrollToBottomIfEnabled]);

  // Clear xterm and write new content, scrolling to bottom after data is processed.
  // The backend now sends serialized terminal state (via @xterm/addon-serialize)
  // which contains only text + color attributes, no cursor movement sequences.
  const replaceXtermContent = useCallback((data: string) => {
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.write(data, () => {
        scrollToBottomIfEnabled();
      });
    }
  }, [scrollToBottomIfEnabled]);

  // WebSocket event handlers
  const handleTerminalOutput = useCallback((data: any) => {
    // WebSocket message structure: data is the payload containing TerminalOutput
    // Check both direct and nested data structures
    const dataSessionName = data?.sessionName || data?.payload?.sessionName;
    const dataContent = data?.content || data?.payload?.content;

    if (data && dataSessionName === selectedSessionRef.current) {
      // Write incremental data to xterm.js (don't replace - append for streaming)
      // Auto-scroll is handled inside writeToXterm via xterm's write callback
      writeToXterm(dataContent || '');

      // Clear loading state when we receive terminal output
      setLoading(false);

      // Clear session switch timeout since we got content
      clearSessionTimeouts();
    }
  }, [clearSessionTimeouts, writeToXterm]);

  const handleInitialTerminalState = useCallback((data: any) => {
    // Check both direct sessionName and nested structure
    const dataSessionName = data?.sessionName || data?.payload?.sessionName;
    const dataContent = data?.content || data?.payload?.content;

    if (data && dataSessionName === selectedSessionRef.current) {
      // Write to xterm.js for proper escape sequence handling
      replaceXtermContent(dataContent || '');
      setLoading(false);

      // Clear session timeouts since we got the response
      clearSessionTimeouts();
    }
  }, [clearSessionTimeouts, replaceXtermContent]);

  const handleConnectionError = useCallback((data: any) => {
    setError(data.error || 'WebSocket connection error');
    setConnectionStatus('error');
    setLoading(false);
  }, []);

  /**
   * Handles session pending events from WebSocket.
   * Implements exponential backoff retry logic for session subscription.
   * Uses refs to check current session state and prevent stale closures.
   *
   * @param data - The session pending event data containing sessionName
   */
  const handleSessionPending = useCallback((data: any) => {
    const dataSessionName = data?.sessionName || data?.payload?.sessionName;

    // Only process if this is for our current session
    if (dataSessionName !== selectedSessionRef.current) {
      return;
    }

    replaceXtermContent('# Session is being created, please wait...\r\n# This may take a few moments while the agent starts up.\r\n');
    setLoading(true);

    // Clear existing timeouts before starting new retry logic
    clearSessionTimeouts();

    // Retry subscription with exponential backoff (3s, 6s, 12s, etc.)
    let retryAttempt = 0;
    const maxRetries = 10;
    const baseDelay = 3000;

    /**
     * Schedules the next retry attempt with exponential backoff.
     * Checks if the session has changed before each retry to prevent stale operations.
     */
    const scheduleRetry = () => {
      // Check if we've exceeded max retries
      if (retryAttempt >= maxRetries) {
        setLoading(false);
        replaceXtermContent(`# Session "${selectedSessionRef.current}" is taking longer than expected to start.\r\n# The orchestrator may still be initializing.\r\n# Try refreshing the page or check the backend logs.\r\n`);
        return;
      }

      const delay = Math.min(baseDelay * Math.pow(1.5, retryAttempt), 30000); // Cap at 30s

      sessionPendingRetryRef.current = setTimeout(() => {
        // Check if the session has changed since we scheduled this retry
        // If it has, abort the retry chain to prevent memory leaks and stale operations
        if (dataSessionName !== selectedSessionRef.current) {
          return;
        }

        webSocketService.subscribeToSession(dataSessionName);
        retryAttempt++;
        scheduleRetry();
      }, delay);
    };

    scheduleRetry();
  }, [clearSessionTimeouts]);

  const handleSessionNotFound = useCallback((data: any) => {
    const dataSessionName = data?.sessionName || data?.payload?.sessionName;
    if (dataSessionName === selectedSessionRef.current) {
      setLoading(false);
      // Clear session switch timeout
      clearSessionTimeouts();
    }
  }, [clearSessionTimeouts]);

  const handleConnectionStatusChange = useCallback(() => {
    const status = webSocketService.getConnectionState();
    setConnectionStatus(status);

    if (status === 'connected') {
      setError(null);
    }
  }, []);

  // Initialize WebSocket connection when panel opens
  useEffect(() => {
    if (isOpen) {
      initializeWebSocket();
    } else {
      cleanupWebSocket();
    }

    return () => cleanupWebSocket();
  }, [isOpen]);

  // Handle session switching - clear pending retries when session changes
  useEffect(() => {
    // Clean up any previous intervals/timeouts when session changes
    clearSessionTimeouts();

    if (connectionCheckIntervalRef.current) {
      clearInterval(connectionCheckIntervalRef.current);
      connectionCheckIntervalRef.current = null;
    }
    if (connectionCheckTimeoutRef.current) {
      clearTimeout(connectionCheckTimeoutRef.current);
      connectionCheckTimeoutRef.current = null;
    }

    if (isOpen && selectedSession) {
      // Check if WebSocket is connected, if not, wait for connection
      if (webSocketService.isConnected()) {
        switchSession(selectedSession);
      } else {
        // Wait for connection with timeout
        connectionCheckIntervalRef.current = setInterval(() => {
          if (webSocketService.isConnected()) {
            if (connectionCheckIntervalRef.current) {
              clearInterval(connectionCheckIntervalRef.current);
              connectionCheckIntervalRef.current = null;
            }
            switchSession(selectedSession);
          }
        }, 100);

        // Clear interval after 5 seconds if still not connected
        connectionCheckTimeoutRef.current = setTimeout(() => {
          if (connectionCheckIntervalRef.current) {
            clearInterval(connectionCheckIntervalRef.current);
            connectionCheckIntervalRef.current = null;
          }
          if (!webSocketService.isConnected()) {
            console.error('WebSocket not connected after 5 seconds, cannot switch session');
            setError('Connection lost. Please refresh the page.');
          }
        }, 5000);
      }
    }

    // Cleanup function to prevent memory leaks
    return () => {
      // Clear session-related timeouts when session changes or component unmounts
      clearSessionTimeouts();

      if (connectionCheckIntervalRef.current) {
        clearInterval(connectionCheckIntervalRef.current);
        connectionCheckIntervalRef.current = null;
      }
      if (connectionCheckTimeoutRef.current) {
        clearTimeout(connectionCheckTimeoutRef.current);
        connectionCheckTimeoutRef.current = null;
      }
    };
  }, [selectedSession, isOpen, clearSessionTimeouts]);

  const initializeWebSocket = async () => {
    try {
      setLoading(true);
      setConnectionStatus('connecting');
      setError(null);

      // Set up event listeners
      webSocketService.on('terminal_output', handleTerminalOutput);
      webSocketService.on('initial_terminal_state', handleInitialTerminalState);
      webSocketService.on('error', handleConnectionError);
      webSocketService.on('connected', handleConnectionStatusChange);
      webSocketService.on('connection_failed', handleConnectionError);
      webSocketService.on('session_pending', handleSessionPending);
      webSocketService.on('session_not_found', handleSessionNotFound);

      // Connect to WebSocket
      await webSocketService.connect();
      setConnectionStatus('connected');

      // Load available sessions and subscribe to default session
      await loadAvailableSessions();

      if (selectedSession) {
        switchSession(selectedSession);
      }

    } catch (error) {
      console.error('Failed to initialize WebSocket:', error);
      setError('Failed to connect to terminal service');
      setConnectionStatus('error');
      setLoading(false);
    }
  };

  const cleanupWebSocket = () => {
    // Clear all session-related timeouts
    clearSessionTimeouts();

    // Clear resize debounce timer
    if (resizeStateRequestRef.current) {
      clearTimeout(resizeStateRequestRef.current);
      resizeStateRequestRef.current = null;
    }

    // Unsubscribe from current session
    if (currentSubscription.current) {
      webSocketService.unsubscribeFromSession(currentSubscription.current);
      currentSubscription.current = null;
    }

    // Remove event listeners
    webSocketService.off('terminal_output', handleTerminalOutput);
    webSocketService.off('initial_terminal_state', handleInitialTerminalState);
    webSocketService.off('error', handleConnectionError);
    webSocketService.off('connected', handleConnectionStatusChange);
    webSocketService.off('connection_failed', handleConnectionError);
    webSocketService.off('session_pending', handleSessionPending);
    webSocketService.off('session_not_found', handleSessionNotFound);

    // Note: Do NOT disconnect the shared WebSocket singleton here.
    // Other components (ChatContext, OrchestratorStatusBanner) rely on it.
    setConnectionStatus('disconnected');
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
    setError(null);
    setLoading(false);
  };

  const switchSession = (sessionName: string) => {
    // Clear any existing session timeouts
    clearSessionTimeouts();

    // Reset auto-scroll when switching sessions
    isUserScrolledUp.current = false;

    // Unsubscribe from previous session
    if (currentSubscription.current && currentSubscription.current !== sessionName) {
      webSocketService.unsubscribeFromSession(currentSubscription.current);
    }

    // Check WebSocket connection status
    if (!webSocketService.isConnected()) {
      // Prevent infinite reconnect loop
      if (reconnectAttemptRef.current >= maxReconnectAttempts) {
        setError('Failed to connect after multiple attempts. Please refresh the page.');
        setLoading(false);
        reconnectAttemptRef.current = 0;
        return;
      }

      reconnectAttemptRef.current++;
      setError('WebSocket disconnected. Attempting to reconnect...');
      setConnectionStatus('reconnecting');

      // Try to reconnect with retry limit
      webSocketService.connect().then(() => {
        reconnectAttemptRef.current = 0; // Reset on successful connection
        switchSession(sessionName); // Retry after connection
      }).catch(() => {
        setError('Failed to connect to terminal service. Please refresh the page.');
        setLoading(false);
      });
      return;
    }

    // Reset reconnect attempts on successful connection
    reconnectAttemptRef.current = 0;

    // Subscribe to new session
    setLoading(true);
    setError(null);
    replaceXtermContent('# Connecting to terminal session...\r\n# Fetching live terminal output...\r\n');

    // Sync PTY dimensions BEFORE subscribing so the initial terminal state
    // is generated at the correct dimensions. Without this, the raw history
    // replayed by sendCurrentTerminalState contains cursor movement sequences
    // calculated for the old 80x24 default, causing rendering corruption in
    // the wider/taller frontend xterm.js terminal.
    if (fitAddonRef.current && !inProcessSessionsRef.current.has(sessionName)) {
      const dimensions = fitAddonRef.current.proposeDimensions();
      if (dimensions) {
        webSocketService.resizeTerminal(sessionName, dimensions.cols, dimensions.rows);
      }
    }

    webSocketService.subscribeToSession(sessionName);
    currentSubscription.current = sessionName;

    // Set timeout fallback to clear loading state if no response comes within 10 seconds
    sessionSwitchTimeout.current = setTimeout(() => {
      // Check if this timeout is still relevant (session hasn't changed)
      if (sessionName === selectedSessionRef.current) {
        setLoading(false);
        replaceXtermContent(`# Connection timeout for session: ${sessionName}\r\n# No response from server after 10 seconds.\r\n# Try refreshing the page or selecting a different session.\r\n`);
      }
      sessionSwitchTimeout.current = null;
    }, 10000);
  };

  const loadAvailableSessions = async () => {
    try {
      // Get available terminal sessions from the backend
      const sessionsResponse = await fetch('/api/terminal/sessions');
      if (!sessionsResponse.ok) {
        setSessionsLoaded(true);
        return;
      }

      const result = await sessionsResponse.json();

      // Backend returns { success: true, data: { sessions: string[], inProcessSessions?: string[] } }
      const sessionNames = result.success && result.data?.sessions ? result.data.sessions : [];
      const inProcessNames: string[] = result.data?.inProcessSessions || [];
      if (Array.isArray(sessionNames)) {
        const sessions = sessionNames.map((sessionName: string) => ({
          id: sessionName,
          name: sessionName,
          displayName: sessionName === 'crewly-orc' ? 'Orchestrator' :
                      sessionName.replace('crewly-', ''),
          type: sessionName === 'crewly-orc' ? 'orchestrator' as const : 'team_member' as const,
          isInProcess: inProcessNames.includes(sessionName),
        }));

        // Ensure orchestrator is always first
        sessions.sort((a, b) => {
          if (a.type === 'orchestrator') return -1;
          if (b.type === 'orchestrator') return 1;
          return a.displayName.localeCompare(b.displayName);
        });

        setAvailableSessions(sessions);

        // Update in-process sessions ref for input blocking
        inProcessSessionsRef.current = new Set(inProcessNames);

        // If current selectedSession is not in the available sessions, update to first available
        // This fixes the bug where the default 'crewly-orc' session may not exist
        const currentSessionExists = sessions.some(s => s.id === selectedSession);
        if (!currentSessionExists && sessions.length > 0) {
          setSelectedSession(sessions[0].id);
        }
      } else {
        setAvailableSessions([]);
      }
      setSessionsLoaded(true);
    } catch {
      setSessionsLoaded(true);
    }
  };

  const retryConnection = () => {
    setError(null);
    initializeWebSocket();
  };

  // Focus the xterm terminal when panel opens so it can receive keyboard input directly
  // xterm.js handles all keyboard input natively through its onData callback
  useEffect(() => {
    if (isOpen && xtermRef.current) {
      // Focus the xterm terminal element to receive keyboard events
      xtermRef.current.focus();
    }
  }, [isOpen, xtermInitialized]);

  // Swipe-to-close gesture: detect horizontal swipe on the panel header area
  const SWIPE_THRESHOLD = 80; // px needed to trigger close
  const handlePanelTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
    touchDeltaXRef.current = 0;
    isSwiping.current = false;
  }, []);

  const handlePanelTouchMove = useCallback((e: React.TouchEvent) => {
    const deltaX = e.touches[0].clientX - touchStartXRef.current;
    const deltaY = Math.abs(e.touches[0].clientY - touchStartYRef.current);

    // Only track horizontal swipes (rightward) when horizontal movement > vertical
    if (deltaX > 10 && deltaX > deltaY) {
      isSwiping.current = true;
      touchDeltaXRef.current = deltaX;
      setSwipeOffset(deltaX);
    }
  }, []);

  const handlePanelTouchEnd = useCallback(() => {
    if (isSwiping.current && touchDeltaXRef.current > SWIPE_THRESHOLD) {
      onClose();
    }
    // Reset swipe state
    isSwiping.current = false;
    touchDeltaXRef.current = 0;
    setSwipeOffset(0);
  }, [onClose]);

  // Compute inline transform for swipe-in-progress feedback
  const panelStyle: React.CSSProperties = swipeOffset > 0
    ? { transform: `translateX(${swipeOffset}px)`, transition: 'none' }
    : {};

  return (
    <>
      {/* Backdrop overlay for mobile — provides context and tap-to-close */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 sm:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        ref={terminalPanelRef}
        className={`fixed top-0 right-0 h-full bg-surface-dark border-l border-border-dark flex flex-col z-50 transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        } w-full sm:w-[600px]`}
        style={isOpen ? panelStyle : undefined}
      >
        {/* Header — larger touch targets on mobile, swipe gesture zone */}
        <div
          className="flex items-center justify-between p-3 sm:p-4 border-b border-border-dark"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
          onTouchStart={handlePanelTouchStart}
          onTouchMove={handlePanelTouchMove}
          onTouchEnd={handlePanelTouchEnd}
        >
          {/* Swipe indicator pill — visible on mobile only */}
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-text-secondary-dark/30 sm:hidden" />

          <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
            <TerminalIcon className="w-5 h-5 text-text-secondary-dark shrink-0" />
            <span className="font-medium text-text-primary-dark truncate">Terminal</span>
            <div className="flex items-center space-x-1.5 shrink-0">
              <div className={`w-2 h-2 rounded-full ${
                connectionStatus === 'connected' ? 'bg-green-400' :
                connectionStatus === 'connecting' || connectionStatus === 'reconnecting' ? 'bg-yellow-400' :
                connectionStatus === 'error' ? 'bg-red-400' : 'bg-gray-400'
              }`}></div>
              <span className="text-xs sm:text-sm text-text-secondary-dark">
                {connectionStatus === 'connected' ? 'Live' :
                 connectionStatus === 'connecting' ? 'Connecting...' :
                 connectionStatus === 'reconnecting' ? 'Reconnecting...' :
                 connectionStatus === 'error' ? 'Error' : 'Disconnected'}
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 sm:p-1 text-text-secondary-dark hover:text-text-primary-dark hover:bg-background-dark rounded-lg sm:rounded transition-colors shrink-0 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
            aria-label="Close Terminal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Session selector — taller touch target for the dropdown on mobile */}
        <div className="px-3 sm:px-4 py-2.5 sm:py-3 border-b border-border-dark">
          <div className="flex items-center space-x-2 sm:space-x-3">
            <label htmlFor="session-select" className="text-xs sm:text-sm font-medium text-text-secondary-dark shrink-0">
              Session:
            </label>
            <select
              id="session-select"
              value={selectedSession}
              onChange={(e) => setSelectedSession(e.target.value)}
              className="flex-1 min-w-0 px-2 sm:px-3 py-2 sm:py-1 bg-background-dark border border-border-dark rounded-lg sm:rounded text-sm text-text-primary-dark focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
              disabled={connectionStatus !== 'connected'}
            >
              {availableSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.isInProcess ? `${session.displayName} (Log)` : session.displayName}
                </option>
              ))}
            </select>
            {isCurrentSessionReadOnly && (
              <span className="px-2 py-0.5 text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded shrink-0">
                Read Only
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          {error && (
            <div className="mx-3 sm:mx-4 my-2 px-3 sm:px-4 py-3 bg-red-500/10 border-l-4 border-red-500 text-red-400 flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1 text-sm">{error}</span>
              <Button onClick={retryConnection} variant="ghost" size="sm" className="text-red-400 hover:text-red-300 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0">
                Retry
              </Button>
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            {/* Show empty state when no sessions available */}
            {sessionsLoaded && availableSessions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-6 sm:p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-surface-dark border border-border-dark flex items-center justify-center mb-4">
                  <TerminalIcon className="w-8 h-8 text-text-secondary-dark" />
                </div>
                <h3 className="text-lg font-medium text-text-primary-dark mb-2">
                  No Terminal Sessions Available
                </h3>
                <p className="text-sm text-text-secondary-dark mb-6 max-w-sm">
                  The orchestrator is not running. Start the orchestrator to enable terminal sessions for your agents.
                </p>
                <Button
                  onClick={() => {
                    onClose();
                    navigate('/teams/orchestrator');
                  }}
                  variant="primary"
                  size="default"
                  className="flex items-center space-x-2"
                >
                  <Play className="w-4 h-4" />
                  <span>Go to Orchestrator</span>
                </Button>
              </div>
            ) : (
              <div
                ref={terminalContainerRef}
                className="h-full w-full bg-background-dark touch-pan-y"
                style={{ minHeight: '100%' }}
              />
            )}
          </div>

          {loading && connectionStatus === 'connected' && (
            <div
              className="px-3 sm:px-4 py-2 border-t border-border-dark"
              style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
            >
              <div className="flex items-center space-x-2 text-sm text-text-secondary-dark">
                <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
                <span>Loading terminal output...</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
