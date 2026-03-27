import React from 'react';
import clsx from 'clsx';
import { DashboardNavigationProps } from './types';

const TABS = ['overview', 'teams', 'terminal'] as const;

export const DashboardNavigation: React.FC<DashboardNavigationProps> = ({
  activeTab,
  onTabChange
}) => {
  return (
    <nav className="bg-white shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex space-x-8">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={clsx(
                'py-3 px-1 border-b-2 font-medium text-sm capitalize transition-colors',
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              )}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
};