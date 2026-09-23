import React, { useState, useEffect, useRef } from 'react';
import { Alert } from '@crewly/ui/Alert';
import { Badge, type BadgeVariant } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { EmptyState } from '@crewly/ui/EmptyState';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Modal } from '@crewly/ui/Modal';
import { StatusDot } from '@crewly/ui/StatusDot';
import { Tabs, TabList, TabTrigger, TabContent } from '@crewly/ui/Tabs';
import { Toggle } from '@crewly/ui/Toggle';
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

/**
 * Details dialog for a team member: system prompt and live terminal output.
 *
 * @param props - The member, its team id and the close handler
 * @returns The member dialog
 */
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

  /** Role → text colour class for the role badge. */
  const getRoleColorClass = (role: string): string => {
    const roleColors: Record<string, string> = {
      orchestrator: 'text-primary',
      pm: 'text-blue-400',
      developer: 'text-emerald-400',
      qa: 'text-amber-400',
      tester: 'text-red-400',
      designer: 'text-pink-400',
    };
    return roleColors[role] || 'text-text-secondary-dark';
  };

  /** Agent status → badge variant. */
  const getAgentStatusVariant = (agentStatus: string): BadgeVariant => {
    const variants: Record<string, BadgeVariant> = {
      activating: 'warning',
      active: 'success',
    };
    return variants[agentStatus] || 'default';
  };

  /** Working status → badge variant. */
  const getWorkingStatusVariant = (workingStatus: string): BadgeVariant =>
    workingStatus === 'in_progress' ? 'success' : 'default';

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const title = (
    <span className="flex flex-col gap-2">
      <span>{member.name}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge className={getRoleColorClass(member.role)}>{member.role}</Badge>
        <Badge variant={getAgentStatusVariant(member.agentStatus)}>Agent: {member.agentStatus}</Badge>
        <Badge variant={getWorkingStatusVariant(member.workingStatus)}>Work: {member.workingStatus}</Badge>
      </span>
    </span>
  );

  return (
    <Modal isOpen onClose={onClose} title={title} size="xxl">
      <Tabs value={activeTab} onValueChange={(tab) => setActiveTab(tab as 'prompt' | 'terminal')}>
        <TabList aria-label="Member details">
          <TabTrigger value="prompt">System Prompt</TabTrigger>
          <TabTrigger value="terminal">Terminal Output</TabTrigger>
        </TabList>

        {/* System Prompt Tab */}
        <TabContent value="prompt">
          <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-2xl border border-border-dark bg-background-dark p-4 text-xs font-mono text-text-primary-dark">
            {member.systemPrompt}
          </pre>
        </TabContent>

        {/* Terminal Tab */}
        <TabContent value="terminal" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-text-secondary-dark">
              {member.sessionName && <span>Session: {member.sessionName}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary-dark">
                <StatusDot status={isRealTimeConnected ? 'online' : 'offline'} size="sm" />
                {isRealTimeConnected ? 'Live' : 'Offline'}
              </span>
              <Toggle
                size="sm"
                label="Auto-refresh (fallback)"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                disabled={isRealTimeConnected}
              />
              <Button
                onClick={fetchSessionData}
                disabled={isRealTimeConnected}
                loading={loading}
                variant="secondary"
                size="sm"
              >
                {loading ? 'Loading...' : 'Manual Refresh'}
              </Button>
            </div>
          </div>

          {loading && !sessionData && (
            <LoadingSpinner size="md" text="Loading session data..." className="py-8" />
          )}

          {error && (
            <div className="space-y-2">
              <Alert variant="error">Error: {error}</Alert>
              <Button onClick={fetchSessionData} variant="outline" size="sm">
                Retry
              </Button>
            </div>
          )}

          {sessionData && (
            <div className="space-y-2">
              <p className="text-xs text-text-secondary-dark">
                Last updated: {formatTimestamp(sessionData.timestamp)}
              </p>
              <pre
                className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-2xl border border-border-dark bg-background-dark p-4 text-xs font-mono text-text-primary-dark"
                ref={terminalOutputRef}
              >
                {sessionData.output || 'No output available'}
              </pre>
            </div>
          )}

          {!loading && !error && !sessionData && (
            <EmptyState compact title="No session data available" />
          )}
        </TabContent>
      </Tabs>
    </Modal>
  );
};
