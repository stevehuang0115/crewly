import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
	Home,
	FolderOpen,
	Users,
	MessageSquare,
	Settings,
	ChevronLeft,
	ChevronRight,
	X,
	Store,
	Clock,
	Shield,
} from 'lucide-react';
import clsx from 'clsx';
import { useSidebar } from '../../contexts/SidebarContext';
import { IconButton } from '../UI';
import { QRCodeDisplay } from './QRCodeDisplay';
import { AuthStatusIndicator } from '../Auth/AuthStatusIndicator';

const navigationItems = [
	{ name: 'Dashboard', href: '/', icon: Home },
	{ name: 'Chat', href: '/chat', icon: MessageSquare },
	{ name: 'Teams', href: '/teams', icon: Users },
	{ name: 'Projects', href: '/projects', icon: FolderOpen },
	{ name: 'Marketplace', href: '/marketplace', icon: Store },
];

interface NavigationProps {
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
}

export const Navigation: React.FC<NavigationProps> = ({ isMobileOpen, onMobileClose }) => {
  const location = useLocation();
  const { isCollapsed, toggleSidebar } = useSidebar();

  const handleLinkClick = () => {
    if (onMobileClose) {
      onMobileClose();
    }
  };

  // Detect when viewing a specific project to show contextual sub-navigation
  const projectMatch = location.pathname.match(/\/projects\/([^/]+)/);
  const activeProjectId = projectMatch ? projectMatch[1] : null;
  const activeHash = (location.hash || '#detail').replace('#', '') as 'detail' | 'editor' | 'tasks' | 'teams';

	return (
    <div className={clsx(
            'flex flex-col h-screen max-h-screen bg-surface-dark/95 border-r border-border-dark overflow-hidden w-full'
        )}>
			{/* Logo Section */}
			<div className="flex items-center justify-between p-4 border-b border-border-dark">
				<div className="flex items-center">
					<div className="p-1">
						<img src="/logo/crewly-icon.svg" alt="Crewly" className="h-8 w-8 invert" />
					</div>
					{(!isCollapsed || isMobileOpen) && (
						<span className="ml-3 text-2xl font-extrabold text-text-primary-dark font-logo">
							CREWLY
						</span>
					)}
				</div>
				{onMobileClose && (
					<IconButton
						variant="ghost"
						icon={X}
						onClick={onMobileClose}
						className="md:hidden -mr-2"
						aria-label="Close menu"
					/>
				)}
			</div>

			{/* Main Navigation */}
            <nav className="flex-1 px-2 py-3 overflow-y-auto">
				<div className="space-y-2">
            {navigationItems.map((item) => {
              const isActive =
                location.pathname === item.href ||
                (item.href !== '/' && location.pathname.startsWith(item.href));

              return (
                <div key={item.name}>
                  <NavLink
                    to={item.href}
                    onClick={handleLinkClick}
                    className={clsx(
                      'group flex items-center px-4 py-2 rounded-lg text-sm transition-colors',
                      isCollapsed ? 'md:justify-center' : '',
                      isActive
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
                    )}
                    title={isCollapsed ? item.name : undefined}
                  >
                    <item.icon className={clsx("h-5 w-5 flex-shrink-0", isActive ? "text-primary" : "")} />
                    <span className={clsx('ml-3', isCollapsed ? 'md:hidden' : '')}>{item.name}</span>
                  </NavLink>

                  {/* Nest project sub-nav directly under Projects item when viewing a project */}
                  {(!isCollapsed || isMobileOpen) && item.href === '/projects' && activeProjectId && (
                    <div className="mt-2 ml-4 space-y-1 border-l border-border-dark pl-4">
                      <NavLink
                        to={`/projects/${activeProjectId}#detail`}
                        onClick={handleLinkClick}
                        className={() =>
                          clsx(
                            'block px-4 py-2 text-sm rounded-lg transition-colors',
                            activeHash === 'detail'
                              ? 'text-primary font-medium bg-primary/10'
                              : 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
                          )
                        }
                      >
                        Overview
                      </NavLink>
                      <NavLink
                        to={`/projects/${activeProjectId}#editor`}
                        onClick={handleLinkClick}
                        className={() =>
                          clsx(
                            'block px-4 py-2 text-sm rounded-lg transition-colors',
                            activeHash === 'editor'
                              ? 'text-primary font-medium bg-primary/10'
                              : 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
                          )
                        }
                      >
                        Editor
                      </NavLink>
                      <NavLink
                        to={`/projects/${activeProjectId}#tasks`}
                        onClick={handleLinkClick}
                        className={() =>
                          clsx(
                            'block px-4 py-2 text-sm rounded-lg transition-colors',
                            activeHash === 'tasks'
                              ? 'text-primary font-medium bg-primary/10'
                              : 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
                          )
                        }
                      >
                        Tasks
                      </NavLink>
                      <NavLink
                        to={`/projects/${activeProjectId}#teams`}
                        onClick={handleLinkClick}
                        className={() =>
                          clsx(
                            'block px-4 py-2 text-sm rounded-lg transition-colors',
                            activeHash === 'teams'
                              ? 'text-primary font-medium bg-primary/10'
                              : 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
                          )
                        }
                      >
                        Teams
                      </NavLink>
                      <NavLink
                        to={`/knowledge?project=${activeProjectId}`}
                        onClick={handleLinkClick}
                        className={() =>
                          clsx(
                            'block px-4 py-2 text-sm rounded-lg transition-colors',
                            'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
                          )
                        }
                      >
                        Knowledge
                      </NavLink>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </nav>

			{/* Bottom Section - Cloud Auth, Settings, QR Code and Toggle button */}
			<div className="p-2 border-t border-border-dark space-y-1">
				{/* Cloud Auth Status */}
				<AuthStatusIndicator isCollapsed={isCollapsed && !isMobileOpen} />

				{/* Security Link */}
				<NavLink
					to="/security"
					onClick={handleLinkClick}
					className={({ isActive }) =>
						clsx(
							'group flex items-center px-4 py-2 rounded-lg text-sm transition-colors',
							isCollapsed && !isMobileOpen ? 'md:justify-center' : '',
							isActive
								? 'bg-primary/10 text-primary font-semibold'
								: 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
						)
					}
					title={isCollapsed && !isMobileOpen ? 'Security' : undefined}
				>
					<Shield className="h-5 w-5 flex-shrink-0" />
					<span className={clsx('ml-3', isCollapsed && !isMobileOpen ? 'md:hidden' : '')}>Security</span>
				</NavLink>

				{/* Schedules Link */}
				<NavLink
					to="/scheduled-checkins"
					onClick={handleLinkClick}
					className={({ isActive }) =>
						clsx(
							'group flex items-center px-4 py-2 rounded-lg text-sm transition-colors',
							isCollapsed && !isMobileOpen ? 'md:justify-center' : '',
							isActive
								? 'bg-primary/10 text-primary font-semibold'
								: 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
						)
					}
					title={isCollapsed && !isMobileOpen ? 'Schedules' : undefined}
				>
					<Clock className="h-5 w-5 flex-shrink-0" />
					<span className={clsx('ml-3', isCollapsed && !isMobileOpen ? 'md:hidden' : '')}>Schedules</span>
				</NavLink>

				{/* Settings Link */}
				<NavLink
					to="/settings"
					onClick={handleLinkClick}
					className={({ isActive }) =>
						clsx(
							'group flex items-center px-4 py-2 rounded-lg text-sm transition-colors',
							isCollapsed && !isMobileOpen ? 'md:justify-center' : '',
							isActive
								? 'bg-primary/10 text-primary font-semibold'
								: 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
						)
					}
					title={isCollapsed && !isMobileOpen ? 'Settings' : undefined}
				>
					<Settings className="h-5 w-5 flex-shrink-0" />
					<span className={clsx('ml-3', isCollapsed && !isMobileOpen ? 'md:hidden' : '')}>Settings</span>
				</NavLink>

				{/* QR Code for Mobile Access */}
				<QRCodeDisplay isCollapsed={isCollapsed && !isMobileOpen} />

				{/* Collapse/Expand Button */}
				<button
					className="flex items-center justify-center w-full p-2 text-text-secondary-dark hover:bg-background-dark/60 hover:text-text-primary-dark rounded-lg transition-colors"
					onClick={toggleSidebar}
					aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				>
					{isCollapsed ? (
						<ChevronRight className="h-5 w-5" />
					) : (
						<>
							<ChevronLeft className="h-5 w-5 mr-3" />
							<span className="text-sm">Collapse</span>
						</>
					)}
				</button>
			</div>
		</div>
	);
};
