import React, { useState, useEffect, useRef } from 'react';
import { Button } from '../UI';
import { TeamMember } from '@/types';
import { webSocketService } from '@/services/websocket.service';

interface TeamMemberModalProps {
  member: TeamMember;
  teamId: string;
  onClose: () => void;
}

interface SessionData {
  memberId: string;
  memberName: string;
  sessionName: string;
  output: string;
  timestamp: string;
}

export const TeamMemberModal: React.FC<TeamMemberModalProps> = ({ member, teamId, onClose }) => {
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);
  const [isRealTimeConnected, setIsRealTimeConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'prompt' | 'terminal'>('prompt');
  const terminalOutputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // Initialize WebSocket connection and fetch initial data
    initializeTerminal();
    
    // Cleanup interval on unmount
    return () => {
      cleanupTerminal();
    };
  }, [member.id, teamId]);

  const initializeTerminal = async () => {
    if (!member.sessionName) {
      setError('No active session for this team member');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Connect to WebSocket if not connected
      if (!webSocketService.isConnected()) {
        await webSocketService.connect();
      }

      // Set up WebSocket event listeners
      setupWebSocketListeners();

      // Subscribe to the session
      webSocketService.subscribeToSession(member.sessionName);
      
      // Also fetch initial session data via REST API as fallback
      await fetchSessionData();
      
    } catch (error) {
      console.error('Error initializing terminal:', error);
      setError('Failed to connect to terminal');
      setIsRealTimeConnected(false);
    } finally {
      setLoading(false);
    }
  };

  const setupWebSocketListeners = () => {
    if (!member.sessionName) return;

    // Handle real-time terminal output
    const handleTerminalOutput = (data: any) => {
      if (data.sessionName === member.sessionName) {
        // Update session output
        setSessionData(prev => ({
          ...prev,
          memberId: member.id,
          memberName: member.name,
          sessionName: member.sessionName!,
          output: data.content,
          timestamp: data.timestamp
        }));
        
        // Auto-scroll to bottom
        setTimeout(() => {
          if (terminalOutputRef.current) {
            terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
          }
        }, 10);
      }
    };

    // Handle initial terminal state
    const handleInitialState = (data: any) => {
      if (data.sessionName === member.sessionName) {
        // Update session output
        setSessionData({
          memberId: member.id,
          memberName: member.name,
          sessionName: member.sessionName!,
          output: data.content,
          timestamp: data.timestamp
        });
        setIsRealTimeConnected(true);
        setError(null);
      }
    };

    // Handle subscription confirmation
    const handleSubscriptionConfirmed = (data: any) => {
      if (data.sessionName === member.sessionName) {
        console.log('Successfully subscribed to session:', data.sessionName);
        setIsRealTimeConnected(true);
        setError(null);
      }
    };

    // Handle WebSocket errors
    const handleError = (data: any) => {
      if (data.sessionName === member.sessionName) {
        console.error('WebSocket error for session:', data);
        setError(data.error || 'WebSocket error occurred');
        setIsRealTimeConnected(false);
      }
    };

    // Handle connection status
    const handleConnected = () => {
      setIsRealTimeConnected(true);
    };

    // Add event listeners
    webSocketService.on('terminal_output', handleTerminalOutput);
    webSocketService.on('initial_terminal_state', handleInitialState);
    webSocketService.on('subscription_confirmed', handleSubscriptionConfirmed);
    webSocketService.on('error', handleError);
    webSocketService.on('connected', handleConnected);

    // Store cleanup function
    return () => {
      webSocketService.off('terminal_output', handleTerminalOutput);
      webSocketService.off('initial_terminal_state', handleInitialState);
      webSocketService.off('subscription_confirmed', handleSubscriptionConfirmed);
      webSocketService.off('error', handleError);
      webSocketService.off('connected', handleConnected);
    };
  };

  const cleanupTerminal = () => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
    
    if (member.sessionName && webSocketService.isConnected()) {
      webSocketService.unsubscribeFromSession(member.sessionName);
    }
  };

  useEffect(() => {
    // Handle auto-refresh
    if (autoRefresh) {
      const interval = setInterval(() => {
        fetchSessionData();
      }, 15000); // Refresh every 15 seconds (reduced frequency)
      setRefreshInterval(interval);
    } else {
      if (refreshInterval) {
        clearInterval(refreshInterval);
        setRefreshInterval(null);
      }
    }

    return () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, [autoRefresh]);

  const fetchSessionData = async () => {
    if (!member.sessionName) {
      setError('No active session for this team member');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/teams/${teamId}/members/${member.id}/session?lines=100`);
      
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setSessionData(result.data);
        } else {
          setError(result.error || 'Failed to fetch session data');
        }
      } else {
        const errorResult = await response.json();
        setError(errorResult.error || 'Failed to fetch session data');
      }
    } catch (err) {
      setError('Network error while fetching session data');
      console.error('Error fetching session data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const getRoleColor = (role: string) => {
    const roleColors: Record<string, string> = {
      orchestrator: '#2a73ea',
      pm: '#3b82f6',
      developer: '#10b981',
      qa: '#f59e0b',
      tester: '#ef4444',
      designer: '#ec4899'
    };
    return roleColors[role] || '#6b7280';
  };

  const getAgentStatusColor = (agentStatus: string) => {
    const statusColors: Record<string, string> = {
      inactive: '#6b7280',
      activating: '#f59e0b', // Orange for activating state
      active: '#059669' // Bright green for active state
    };
    return statusColors[agentStatus] || '#6b7280';
  };

  const getWorkingStatusColor = (workingStatus: string) => {
    const statusColors: Record<string, string> = {
      idle: '#6b7280',
      in_progress: '#10b981'
    };
    return statusColors[workingStatus] || '#6b7280';
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content member-modal-content">
        <div className="modal-header">
          <div className="member-header-info">
            <h2>{member.name}</h2>
            <div className="member-badges">
              <span 
                className="role-badge"
                style={{ backgroundColor: getRoleColor(member.role) }}
              >
                {member.role}
              </span>
              <span 
                className="status-badge"
                style={{ backgroundColor: getAgentStatusColor(member.agentStatus) }}
              >
                Agent: {member.agentStatus}
              </span>
              <span 
                className="status-badge"
                style={{ backgroundColor: getWorkingStatusColor(member.workingStatus) }}
              >
                Work: {member.workingStatus}
              </span>
            </div>
          </div>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        {/* Tab Navigation */}
        <div className="member-tabs">
          <button 
            className={`tab-button ${activeTab === 'prompt' ? 'active' : ''}`}
            onClick={() => setActiveTab('prompt')}
          >
            System Prompt
          </button>
          <button 
            className={`tab-button ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => setActiveTab('terminal')}
          >
            Terminal Output
          </button>
        </div>

        <div className="member-modal-body">
          {/* System Prompt Tab */}
          {activeTab === 'prompt' && (
            <div className="system-prompt-panel">
              <div className="system-prompt-content">
                <pre className="system-prompt-text">
                  {member.systemPrompt}
                </pre>
              </div>
            </div>
          )}

          {/* Terminal Tab */}
          {activeTab === 'terminal' && (
            <div className="terminal-panel">
              <div className="terminal-header">
                <div className="terminal-header-left">
                  {member.sessionName && (
                    <span className="session-name">Session: {member.sessionName}</span>
                  )}
                </div>
                <div className="terminal-controls">
                  <div className="connection-status">
                    <span className={`status-indicator ${isRealTimeConnected ? 'connected' : 'disconnected'}`}>
                      {isRealTimeConnected ? '🟢 Live' : '🔴 Offline'}
                    </span>
                  </div>
                  <label className="auto-refresh-toggle">
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(e) => setAutoRefresh(e.target.checked)}
                      disabled={isRealTimeConnected}
                    />
                    Auto-refresh (fallback)
                  </label>
                  <Button 
                    className="refresh-button" 
                    onClick={fetchSessionData}
                    disabled={loading || isRealTimeConnected}
                    variant="secondary"
                    size="sm"
                  >
                    {loading ? 'Loading...' : 'Manual Refresh'}
                  </Button>
                </div>
              </div>

              <div className="terminal-output">
                {loading && !sessionData && (
                  <div className="loading-state">
                    <div className="loading-spinner"></div>
                    <p>Loading session data...</p>
                  </div>
                )}

                {error && (
                  <div className="error-state">
                    <p>Error: {error}</p>
                    <Button onClick={fetchSessionData} className="retry-button" variant="outline" size="sm">
                      Retry
                    </Button>
                  </div>
                )}

                {sessionData && (
                  <div className="session-data">
                    <div className="session-meta">
                      <span>Last updated: {formatTimestamp(sessionData.timestamp)}</span>
                    </div>
                    <pre className="terminal-content" ref={terminalOutputRef}>
                      {sessionData.output || 'No output available'}
                    </pre>
                  </div>
                )}

                {!loading && !error && !sessionData && (
                  <div className="empty-state">
                    <p>No session data available</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
