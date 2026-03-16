import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Clock, User, CheckCircle, AlertCircle, Play } from 'lucide-react';
import { webSocketService } from '../../services/websocket.service';
import { formatDistanceToNow } from 'date-fns';

interface ActivityItem {
  id: string;
  type: 'status_change' | 'task_update' | 'system';
  agentName: string;
  sessionName: string;
  message: string;
  timestamp: Date;
  status?: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
}

export const RecentActivityPanel: React.FC = () => {
  const [activities, setActivities] = useState<ActivityItem[]>([]);

  const addActivity = useCallback((activity: Omit<ActivityItem, 'id' | 'timestamp'>) => {
    const newActivity: ActivityItem = {
      ...activity,
      id: Math.random().toString(36).substring(2, 11),
      timestamp: new Date(),
    };
    setActivities(prev => [newActivity, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    const handleStatusChange = (payload: any) => {
      const { memberName, sessionName, newValue, previousValue } = payload;
      addActivity({
        type: 'status_change',
        agentName: memberName || sessionName,
        sessionName,
        message: `Changed status from ${previousValue} to ${newValue}`,
        status: newValue,
        severity: newValue === 'active' ? 'success' : newValue === 'inactive' ? 'error' : 'info'
      });
    };

    const handleTeamActivity = (payload: any) => {
      // payload structure depends on the specific activity broadcast
      addActivity({
        type: 'task_update',
        agentName: payload.agentName || 'System',
        sessionName: payload.sessionName || '',
        message: payload.message || 'Activity updated',
        severity: 'info'
      });
    };

    webSocketService.on('team_member_status_changed', handleStatusChange);
    webSocketService.on('team_activity_updated', handleTeamActivity);

    return () => {
      webSocketService.off('team_member_status_changed', handleStatusChange);
      webSocketService.off('team_activity_updated', handleTeamActivity);
    };
  }, [addActivity]);

  const getIcon = (item: ActivityItem) => {
    switch (item.type) {
      case 'status_change':
        return <User className="w-4 h-4" />;
      case 'task_update':
        return <CheckCircle className="w-4 h-4" />;
      default:
        return <Activity className="w-4 h-4" />;
    }
  };

  const getSeverityClass = (item: ActivityItem) => {
    switch (item.severity) {
      case 'success': return 'bg-green-100 text-green-700 border-green-200';
      case 'error': return 'bg-red-100 text-red-700 border-red-200';
      case 'warning': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      default: return 'bg-blue-50 text-blue-700 border-blue-100';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-[500px]">
      <div className="p-4 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Activity className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-gray-900">Real-time Execution Feed</h3>
        </div>
        <div className="flex items-center space-x-1">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wider">Live</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activities.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-2">
            <Clock className="w-8 h-8 opacity-20" />
            <p className="text-sm">Waiting for agent activities...</p>
          </div>
        ) : (
          activities.map((item) => (
            <div 
              key={item.id} 
              className={`p-3 rounded-lg border flex items-start space-x-3 transition-all animate-in slide-in-from-top-2 duration-300 ${getSeverityClass(item)}`}
            >
              <div className="mt-0.5 shrink-0">
                {getIcon(item)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm truncate">{item.agentName}</span>
                  <span className="text-[10px] opacity-70 whitespace-nowrap ml-2">
                    {formatDistanceToNow(item.timestamp, { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm leading-tight mt-1">{item.message}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
