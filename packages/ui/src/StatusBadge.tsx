import React from 'react';

export type StatusType = 'active' | 'inactive' | 'stopped' | 'running' | 'paused' | 'completed' | 'blocked' | 'pending' | 'error' | 'suspended';

interface StatusBadgeProps {
  status: StatusType;
  children?: React.ReactNode;
  className?: string;
}

const statusStyles: Record<StatusType, string> = {
  active: 'bg-green-500/10 text-green-400 border-green-500/20',
  running: 'bg-green-500/10 text-green-400 border-green-500/20',
  stopped: 'bg-red-500/10 text-red-400 border-red-500/20',
  inactive: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  paused: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  completed: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
  pending: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  suspended: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  children,
  className = ''
}) => {
  const displayText = children || status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <span
      className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded-full border ${statusStyles[status]} ${className}`}
    >
      {displayText}
    </span>
  );
};