/**
 * Tabs Component
 *
 * Compound component for tabbed navigation.
 * Includes Tabs (container), TabList, TabTrigger, and TabContent.
 *
 * @module components/UI/Tabs
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

// ============ Context ============

interface TabsContextValue {
  /** Currently active tab value */
  activeTab: string;
  /** Function to set active tab */
  setActiveTab: (tab: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

/**
 * Hook to access Tabs context
 * @throws Error if used outside of Tabs component
 */
const useTabsContext = (): TabsContextValue => {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs compound components must be used within a Tabs component');
  }
  return context;
};

// ============ Tabs (Container) ============

export interface TabsProps {
  /** Default active tab value */
  defaultValue: string;
  /** Tab contents (TabList and TabContent components) */
  children: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
  /** Callback when tab changes */
  onValueChange?: (value: string) => void;
}

/**
 * Tabs container component
 *
 * @param defaultValue - Initial active tab value
 * @param children - TabList and TabContent components
 * @param className - Additional CSS classes
 * @param onValueChange - Callback when active tab changes
 * @returns Tabs container
 *
 * @example
 * ```tsx
 * <Tabs defaultValue="general">
 *   <TabList>
 *     <TabTrigger value="general">General</TabTrigger>
 *     <TabTrigger value="settings">Settings</TabTrigger>
 *   </TabList>
 *   <TabContent value="general">General content</TabContent>
 *   <TabContent value="settings">Settings content</TabContent>
 * </Tabs>
 * ```
 */
export const Tabs: React.FC<TabsProps> = ({
  defaultValue,
  children,
  className = '',
  onValueChange,
}) => {
  const [activeTab, setActiveTabState] = useState(defaultValue);

  const setActiveTab = useCallback(
    (tab: string) => {
      setActiveTabState(tab);
      onValueChange?.(tab);
    },
    [onValueChange]
  );

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
};

Tabs.displayName = 'Tabs';

// ============ TabList ============

export interface TabListProps {
  /** TabTrigger components */
  children: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Container for tab triggers/buttons
 *
 * @param children - TabTrigger components
 * @param className - Additional CSS classes
 * @returns Tab list container
 */
export const TabList: React.FC<TabListProps> = ({ children, className = '' }) => {
  const combinedClassName = [
    'flex gap-1 border-b border-border-dark pb-0 mb-6',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const tabs = Array.from(
      e.currentTarget.querySelectorAll('[role="tab"]:not([disabled])')
    ) as HTMLElement[];
    const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);

    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = tabs.length - 1;
    }

    tabs[nextIndex]?.focus();
  };

  return (
    <div className={combinedClassName} role="tablist" onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
};

TabList.displayName = 'TabList';

// ============ TabTrigger ============

export interface TabTriggerProps {
  /** Value that identifies this tab (must match TabContent value) */
  value: string;
  /** Tab button content */
  children: React.ReactNode;
  /** Optional icon element to display before text */
  icon?: React.ReactNode;
  /** Whether this tab is disabled */
  disabled?: boolean;
}

/**
 * Individual tab trigger/button
 *
 * @param value - Tab identifier (must match TabContent value)
 * @param children - Button content
 * @param icon - Optional icon before text
 * @param disabled - Whether tab is disabled
 * @returns Tab trigger button
 */
export const TabTrigger: React.FC<TabTriggerProps> = ({
  value,
  children,
  icon,
  disabled = false,
}) => {
  const { activeTab, setActiveTab } = useTabsContext();
  const isActive = activeTab === value;

  const className = [
    'flex items-center gap-2',
    'px-4 py-3',
    'text-sm font-medium',
    'border-b-2 -mb-px',
    'transition-colors',
    'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background-dark',
    disabled && 'opacity-50 cursor-not-allowed',
    isActive
      ? 'text-primary border-primary'
      : 'text-text-secondary-dark border-transparent hover:text-text-primary-dark hover:bg-background-dark/50',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      onClick={() => !disabled && setActiveTab(value)}
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabpanel-${value}`}
      id={`tab-${value}`}
      disabled={disabled}
      tabIndex={isActive ? 0 : -1}
    >
      {icon}
      {children}
    </button>
  );
};

TabTrigger.displayName = 'TabTrigger';

// ============ TabContent ============

export interface TabContentProps {
  /** Value that identifies this content (must match TabTrigger value) */
  value: string;
  /** Content to display when this tab is active */
  children: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Content panel for a tab
 *
 * @param value - Tab identifier (must match TabTrigger value)
 * @param children - Content to display
 * @param className - Additional CSS classes
 * @returns Tab content panel (or null if not active)
 */
export const TabContent: React.FC<TabContentProps> = ({
  value,
  children,
  className = '',
}) => {
  const { activeTab } = useTabsContext();

  if (activeTab !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`tabpanel-${value}`}
      aria-labelledby={`tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
};

TabContent.displayName = 'TabContent';
