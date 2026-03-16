import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TerminalPanel } from './TerminalPanel';
import { useTerminal } from '../../contexts/TerminalContext';
import { webSocketService } from '../../services/websocket.service';

// Mock the context and service
vi.mock('../../contexts/TerminalContext');
vi.mock('../../services/websocket.service');

// Mock react-router-dom
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// Mock xterm.js
const mockXtermInstance = {
  write: vi.fn((_data: string, callback?: () => void) => {
    // Invoke callback to simulate real xterm.js behavior (fires after data processed)
    if (callback) callback();
  }),
  clear: vi.fn(),
  dispose: vi.fn(),
  open: vi.fn(),
  loadAddon: vi.fn(),
  onData: vi.fn(),
  scrollToBottom: vi.fn(),
  focus: vi.fn(),
  buffer: {
    active: {
      viewportY: 0,
      length: 24,
    },
  },
  rows: 24,
};

vi.mock('xterm', () => ({
  Terminal: vi.fn(() => mockXtermInstance),
}));

const mockFitAddonInstance = {
  fit: vi.fn(),
  proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
};

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => mockFitAddonInstance),
}));

vi.mock('xterm-addon-web-links', () => ({
  WebLinksAddon: vi.fn(() => ({})),
}));

// Mock xterm CSS
vi.mock('xterm/css/xterm.css', () => ({}));

// Mock ResizeObserver
const mockResizeObserverInstance = {
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
};
const mockResizeObserver = vi.fn(() => mockResizeObserverInstance);
global.ResizeObserver = mockResizeObserver as any;

// Mock fetch globally
global.fetch = vi.fn();

const mockUseTerminal = vi.mocked(useTerminal);
const mockWebSocketService = vi.mocked(webSocketService);

describe('TerminalPanel', () => {
  const mockSetSelectedSession = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Reset xterm mock instance methods
    mockXtermInstance.write.mockClear();
    mockXtermInstance.clear.mockClear();
    mockXtermInstance.dispose.mockClear();
    mockXtermInstance.open.mockClear();
    mockXtermInstance.loadAddon.mockClear();
    mockXtermInstance.onData.mockClear();
    mockXtermInstance.scrollToBottom.mockClear();

    // Reset fit addon mock
    mockFitAddonInstance.fit.mockClear();

    // Mock TerminalContext
    mockUseTerminal.mockReturnValue({
      isTerminalOpen: true,
      selectedSession: 'crewly-orc',
      openTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      setSelectedSession: mockSetSelectedSession,
      openTerminalWithSession: vi.fn(),
    });

    // Mock WebSocket service
    mockWebSocketService.on = vi.fn();
    mockWebSocketService.off = vi.fn();
    mockWebSocketService.connect = vi.fn().mockResolvedValue(undefined);
    mockWebSocketService.disconnect = vi.fn();
    mockWebSocketService.isConnected = vi.fn().mockReturnValue(true);
    mockWebSocketService.subscribeToSession = vi.fn();
    mockWebSocketService.unsubscribeFromSession = vi.fn();
    mockWebSocketService.sendInput = vi.fn();
    mockWebSocketService.resizeTerminal = vi.fn();
    mockWebSocketService.getConnectionState = vi.fn().mockReturnValue('connected');

    // Mock fetch for terminal sessions
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          sessions: ['crewly-orc', 'crewly-dev']
        }
      })
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Component Rendering', () => {
    it('renders terminal panel when open', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      expect(screen.getByText('Terminal')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('applies translate-x-0 when open', async () => {
      let container: HTMLElement;
      await act(async () => {
        const result = render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
        container = result.container;
      });
      // Panel is the fixed positioned div (backdrop is a sibling)
      const panel = container!.querySelector('.fixed.bg-surface-dark') as HTMLElement;

      expect(panel).toHaveClass('translate-x-0');
    });

    it('applies translate-x-full when closed', async () => {
      let container: HTMLElement;
      await act(async () => {
        const result = render(<TerminalPanel isOpen={false} onClose={mockOnClose} />);
        container = result.container;
      });
      // When closed, no backdrop — panel is the only fixed element
      const panel = container!.querySelector('.fixed.bg-surface-dark') as HTMLElement;

      expect(panel).toHaveClass('translate-x-full');
    });

    it('shows connection status correctly', async () => {
      // Mock the connect to not resolve immediately
      mockWebSocketService.connect.mockImplementation(() => new Promise(() => {}));
      mockWebSocketService.getConnectionState.mockReturnValue('connecting');

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // The status should show "Connecting..." initially
      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('shows error banner when there is an error', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Simulate error state
      await act(async () => {
        const errorHandler = mockWebSocketService.on.mock.calls.find(
          call => call[0] === 'error'
        )?.[1];
        if (errorHandler) {
          errorHandler({ error: 'Connection failed' });
        }
      });

      await waitFor(() => {
        expect(screen.getByText('Connection failed')).toBeInTheDocument();
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('shows empty state when no sessions available', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { sessions: [] }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(screen.getByText('No Terminal Sessions Available')).toBeInTheDocument();
        expect(screen.getByText('Go to Orchestrator')).toBeInTheDocument();
      });
    });

    it('navigates to orchestrator when button clicked in empty state', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { sessions: [] }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Go to Orchestrator')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Go to Orchestrator'));
      });

      expect(mockOnClose).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/teams/orchestrator');
    });
  });

  describe('Keyboard Event Handling', () => {
    beforeEach(() => {
      Object.defineProperty(document, 'activeElement', {
        value: document.body,
        writable: true
      });
    });

    it('sends Enter key as carriage return', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\r');
    });

    it('sends Escape key correctly', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x1b');
    });

    it('sends Tab key correctly', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Tab' });
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\t');
    });

    it('sends Ctrl+C correctly', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'c', ctrlKey: true });
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x03');
    });

    it('sends Ctrl+L correctly', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'l', ctrlKey: true });
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x0c');
    });

    it('sends arrow keys correctly', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowUp' });
      });
      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x1b[A');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowDown' });
      });
      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x1b[B');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowRight' });
      });
      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x1b[C');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'ArrowLeft' });
      });
      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', '\x1b[D');
    });

    it('sends printable characters correctly', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'a' });
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', 'a');
    });

    it('does not handle keys when terminal is not open', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={false} onClose={mockOnClose} />);
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });

      expect(mockWebSocketService.sendInput).not.toHaveBeenCalled();
    });

    it('does not handle keys when not connected', async () => {
      // Mock disconnected state
      mockWebSocketService.getConnectionState.mockReturnValue('disconnected');
      mockWebSocketService.isConnected.mockReturnValue(false);
      // Make connect hang to keep the status as disconnected
      mockWebSocketService.connect.mockImplementation(() => new Promise(() => {}));

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Wait a bit for the component to settle
      await act(async () => {
        await new Promise(r => setTimeout(r, 50));
      });

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });

      expect(mockWebSocketService.sendInput).not.toHaveBeenCalled();
    });
  });

  describe('WebSocket Integration', () => {
    it('initializes WebSocket connection when panel opens', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(mockWebSocketService.connect).toHaveBeenCalled();
        expect(mockWebSocketService.on).toHaveBeenCalledWith('terminal_output', expect.any(Function));
        expect(mockWebSocketService.on).toHaveBeenCalledWith('initial_terminal_state', expect.any(Function));
        expect(mockWebSocketService.on).toHaveBeenCalledWith('error', expect.any(Function));
      });
    });

    it('subscribes to selected session', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(mockWebSocketService.subscribeToSession).toHaveBeenCalledWith('crewly-orc');
      });
    });

    it('unsubscribes and disconnects when panel closes', async () => {
      let rerender: (ui: React.ReactElement) => void;
      await act(async () => {
        const result = render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
        rerender = result.rerender;
      });

      await act(async () => {
        rerender!(<TerminalPanel isOpen={false} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(mockWebSocketService.unsubscribeFromSession).toHaveBeenCalled();
        expect(mockWebSocketService.disconnect).toHaveBeenCalled();
        expect(mockWebSocketService.off).toHaveBeenCalled();
      });
    });

    it('registers terminal_output handler', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        const outputHandler = mockWebSocketService.on.mock.calls.find(
          call => call[0] === 'terminal_output'
        )?.[1];
        expect(outputHandler).toBeDefined();
      });

      // Verify the handler is registered
      expect(mockWebSocketService.on).toHaveBeenCalledWith('terminal_output', expect.any(Function));
    });
  });

  describe('Session Management', () => {
    it('loads available sessions on initialization', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/terminal/sessions');
      });
    });

    it('switches sessions when dropdown changes', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'crewly-dev' } });
      });

      expect(mockSetSelectedSession).toHaveBeenCalledWith('crewly-dev');
    });

    it('updates selectedSession when current selection is not in available sessions', async () => {
      // Mock selectedSession as a session that doesn't exist in the available sessions
      mockUseTerminal.mockReturnValue({
        isTerminalOpen: true,
        selectedSession: 'non-existent-session',
        openTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        setSelectedSession: mockSetSelectedSession,
        openTerminalWithSession: vi.fn(),
      });

      // Mock fetch to return sessions that don't include the selectedSession
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            sessions: ['business-os-ceo-7a049b72', 'team-member-abc123']
          }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Should update selectedSession to the first available session
      await waitFor(() => {
        expect(mockSetSelectedSession).toHaveBeenCalledWith('business-os-ceo-7a049b72');
      });
    });

    it('does not update selectedSession when current selection exists in available sessions', async () => {
      // Mock selectedSession as a session that exists in the available sessions
      mockUseTerminal.mockReturnValue({
        isTerminalOpen: true,
        selectedSession: 'crewly-orc',
        openTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        setSelectedSession: mockSetSelectedSession,
        openTerminalWithSession: vi.fn(),
      });

      // Mock fetch to return sessions including the selectedSession
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            sessions: ['crewly-orc', 'team-member-abc123']
          }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Give time for the async operations to complete
      await act(async () => {
        await new Promise(r => setTimeout(r, 100));
      });

      // Should NOT call setSelectedSession since current selection is valid
      expect(mockSetSelectedSession).not.toHaveBeenCalled();
    });
  });

  describe('In-Process Session Support', () => {
    it('shows Read Only badge for in-process sessions', async () => {
      // Mock the selected session as an in-process session
      mockUseTerminal.mockReturnValue({
        isTerminalOpen: true,
        selectedSession: 'crewly-assistant',
        openTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        setSelectedSession: mockSetSelectedSession,
        openTerminalWithSession: vi.fn(),
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            sessions: ['crewly-orc', 'crewly-assistant'],
            inProcessSessions: ['crewly-assistant']
          }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(screen.getByText('Read Only')).toBeInTheDocument();
      });
    });

    it('shows (Log) suffix in session dropdown for in-process sessions', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            sessions: ['crewly-orc', 'crewly-assistant'],
            inProcessSessions: ['crewly-assistant']
          }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        const select = screen.getByRole('combobox');
        const options = select.querySelectorAll('option');
        const assistantOption = Array.from(options).find(o => o.textContent?.includes('assistant'));
        expect(assistantOption?.textContent).toContain('(Log)');
      });
    });

    it('does not show Read Only badge for PTY sessions', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            sessions: ['crewly-orc', 'crewly-dev'],
            inProcessSessions: []
          }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(screen.queryByText('Read Only')).not.toBeInTheDocument();
      });
    });

    it('handles missing inProcessSessions field gracefully', async () => {
      // Old backend without inProcessSessions field
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            sessions: ['crewly-orc']
          }
        })
      });

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Should not crash, no Read Only badge
      await waitFor(() => {
        expect(screen.queryByText('Read Only')).not.toBeInTheDocument();
      });
    });
  });

  describe('Close Functionality', () => {
    it('calls onClose when close button is clicked', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const closeButton = screen.getByLabelText('Close Terminal');
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('retries connection when retry button is clicked after error', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Simulate error state
      await act(async () => {
        const errorHandler = mockWebSocketService.on.mock.calls.find(
          call => call[0] === 'error'
        )?.[1];
        if (errorHandler) {
          errorHandler({ error: 'Connection failed' });
        }
      });

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Retry'));
      });

      expect(mockWebSocketService.connect).toHaveBeenCalledTimes(2);
    });
  });

  describe('Focus Management', () => {
    it('panel is rendered with correct structure when open', async () => {
      let container: HTMLElement;
      await act(async () => {
        const result = render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
        container = result.container;
      });
      // Panel element is the fixed positioned div (second child after backdrop)
      const panel = container!.querySelector('.fixed.bg-surface-dark') as HTMLElement;
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveClass('translate-x-0');
    });
  });

  describe('Error Handling', () => {
    it('handles WebSocket connection errors gracefully', async () => {
      mockWebSocketService.connect.mockRejectedValue(new Error('Connection failed'));

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to connect/)).toBeInTheDocument();
      });
    });

    it('handles session loading errors gracefully', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Fetch failed'));

      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Should still render without crashing
      expect(screen.getByText('Terminal')).toBeInTheDocument();
    });
  });

  describe('xterm.js Integration', () => {
    it('initializes xterm when panel opens with sessions', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // Wait for sessions to load
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/terminal/sessions');
      });

      // xterm should be initialized after sessions are loaded
      await waitFor(() => {
        expect(mockXtermInstance.open).toHaveBeenCalled();
        expect(mockXtermInstance.loadAddon).toHaveBeenCalled();
        expect(mockFitAddonInstance.fit).toHaveBeenCalled();
      });
    });

    it('sets up resize observer for terminal container', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      await waitFor(() => {
        expect(mockResizeObserver).toHaveBeenCalled();
      });
    });

    it('disposes xterm on cleanup', async () => {
      let unmount: () => void;
      await act(async () => {
        const result = render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
        unmount = result.unmount;
      });

      await waitFor(() => {
        expect(mockXtermInstance.open).toHaveBeenCalled();
      });

      await act(async () => {
        unmount!();
      });

      expect(mockXtermInstance.dispose).toHaveBeenCalled();
    });
  });

  describe('Mobile UX', () => {
    it('renders backdrop overlay on mobile when open', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // The backdrop is the first child (before the panel) — it has aria-hidden="true"
      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeInTheDocument();
      expect(backdrop).toHaveClass('sm:hidden');
    });

    it('does not render backdrop when closed', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={false} onClose={mockOnClose} />);
      });

      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).not.toBeInTheDocument();
    });

    it('calls onClose when backdrop is tapped', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(backdrop!);
      });

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('renders swipe indicator pill in header', async () => {
      let container: HTMLElement;
      await act(async () => {
        const result = render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
        container = result.container;
      });

      // The swipe pill has sm:hidden class
      const pill = container!.querySelector('.sm\\:hidden.rounded-full');
      expect(pill).toBeInTheDocument();
    });

    it('close button has minimum 44px touch target on mobile', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const closeButton = screen.getByLabelText('Close Terminal');
      expect(closeButton).toHaveClass('min-w-[44px]', 'min-h-[44px]');
    });

    it('terminal container has touch-pan-y class for touch scrolling', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      // The terminal container div should have touch-pan-y
      await waitFor(() => {
        const termContainer = document.querySelector('.touch-pan-y');
        expect(termContainer).toBeInTheDocument();
      });
    });

    it('session select has larger padding on mobile for touch', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const select = screen.getByRole('combobox');
      // py-2 on mobile (sm:py-1 on desktop)
      expect(select).toHaveClass('py-2');
    });
  });

  describe('Terminal Response Filtering', () => {
    /**
     * Helper to get the onData callback registered by the component.
     * xterm.js onData is called with (callback) — we capture it from the mock.
     */
    function getOnDataCallback(): ((data: string) => void) | undefined {
      const call = mockXtermInstance.onData.mock.calls[0];
      return call ? call[0] : undefined;
    }

    it('filters DA1 response from input stream', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const onData = getOnDataCallback();
      expect(onData).toBeDefined();

      // Simulate xterm.js generating a DA1 response
      await act(async () => {
        onData!('\x1b[?1;2c');
      });

      // Should NOT send the DA response to the PTY
      expect(mockWebSocketService.sendInput).not.toHaveBeenCalled();
    });

    it('filters DA2 response from input stream', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const onData = getOnDataCallback();
      expect(onData).toBeDefined();

      await act(async () => {
        onData!('\x1b[>0;276;0c');
      });

      expect(mockWebSocketService.sendInput).not.toHaveBeenCalled();
    });

    it('filters DSR cursor position response from input stream', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const onData = getOnDataCallback();
      expect(onData).toBeDefined();

      await act(async () => {
        onData!('\x1b[24;80R');
      });

      expect(mockWebSocketService.sendInput).not.toHaveBeenCalled();
    });

    it('passes normal input through unchanged', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const onData = getOnDataCallback();
      expect(onData).toBeDefined();

      await act(async () => {
        onData!('hello');
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', 'hello');
    });

    it('strips terminal responses from mixed input', async () => {
      await act(async () => {
        render(<TerminalPanel isOpen={true} onClose={mockOnClose} />);
      });

      const onData = getOnDataCallback();
      expect(onData).toBeDefined();

      // Mixed: normal text with DA response embedded
      await act(async () => {
        onData!('abc\x1b[?1;2cdef');
      });

      expect(mockWebSocketService.sendInput).toHaveBeenCalledWith('crewly-orc', 'abcdef');
    });
  });
});
