/**
 * Factory - React Three Fiber factory visualization page.
 *
 * Displays the 3D factory view with animated agents, office zones,
 * and interactive camera controls.
 *
 * On mobile devices, shows a simplified view instead of the heavy 3D scene
 * to prevent browser crashes.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSidebar } from '@/contexts/SidebarContext';
import { ArrowLeft, Smartphone, Monitor, Factory as FactoryIcon, Users, Cpu, Activity } from 'lucide-react';
import { FactoryScene } from '@/components/Factory3D';
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';

/**
 * Detects if the current device is a mobile device.
 * Uses user agent detection and screen size as fallback.
 */
function detectMobile(): boolean {
  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  const isMobileUA = mobileRegex.test(userAgent);
  const isSmallScreen = window.innerWidth < 768;
  return isMobileUA || isSmallScreen;
}

/**
 * MobileFallback - Shown on mobile devices instead of the 3D scene.
 * Provides a friendly message and option to try loading the 3D view anyway.
 */
const MobileFallback: React.FC<{ onTryAnyway: () => void; onGoBack: () => void }> = ({
  onTryAnyway,
  onGoBack,
}) => (
  <div className="flex flex-col items-center justify-center min-h-screen bg-background-dark p-6 text-center">
    <div className="max-w-md">
      {/* Icon */}
      <div className="mb-6 flex justify-center">
        <div className="relative">
          <FactoryIcon className="w-20 h-20 text-primary/30" />
          <Smartphone className="w-10 h-10 text-primary absolute -bottom-2 -right-2 bg-background-dark rounded-full p-1" />
        </div>
      </div>

      {/* Title */}
      <h1 className="text-2xl font-bold text-text-primary-dark mb-3">
        3D Factory View
      </h1>

      {/* Message */}
      <p className="text-text-secondary-dark mb-6">
        The 3D factory visualization requires significant graphics processing power
        and is optimized for desktop browsers.
      </p>

      {/* Stats preview */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <Card padding="md">
          <Users className="w-6 h-6 text-primary mx-auto mb-2" />
          <p className="text-xs text-text-secondary-dark">Agents</p>
        </Card>
        <Card padding="md">
          <Cpu className="w-6 h-6 text-green-500 mx-auto mb-2" />
          <p className="text-xs text-text-secondary-dark">Active</p>
        </Card>
        <Card padding="md">
          <Activity className="w-6 h-6 text-blue-500 mx-auto mb-2" />
          <p className="text-xs text-text-secondary-dark">Status</p>
        </Card>
      </div>

      {/* Recommendation */}
      <div className="flex items-center gap-2 text-sm text-text-secondary-dark bg-surface-dark border border-border-dark p-3 rounded-2xl mb-6">
        <Monitor className="w-5 h-5 text-primary flex-shrink-0" />
        <span>For the best experience, open this page on a desktop computer.</span>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3">
        <Button variant="primary" fullWidth onClick={onGoBack}>
          Back to Dashboard
        </Button>
        <Button variant="secondary" fullWidth onClick={onTryAnyway}>
          Try Loading Anyway
        </Button>
      </div>

      {/* Warning */}
      <p className="text-xs text-text-secondary-dark/60 mt-4">
        Loading on mobile may cause the browser to become unresponsive
      </p>
    </div>
  </div>
);

/**
 * Factory - Main factory visualization page.
 *
 * Features:
 * - Full React Three Fiber integration
 * - Animated robot agents with animal heads
 * - Day/night lighting modes
 * - Interactive camera controls
 * - Boss mode auto-tour
 * - Mobile fallback view
 *
 * @returns JSX element with FactoryScene or mobile fallback
 */
export const Factory: React.FC = () => {
  const navigate = useNavigate();
  const { collapseSidebar, expandSidebar } = useSidebar();

  // Detect mobile device
  const isMobile = useMemo(() => detectMobile(), []);
  const [forceLoad, setForceLoad] = useState(false);

  // Auto-collapse sidebar when entering Factory view (only on desktop)
  useEffect(() => {
    if (!isMobile || forceLoad) {
      collapseSidebar();
    }

    // Expand sidebar when leaving
    return () => {
      expandSidebar();
    };
  }, [collapseSidebar, expandSidebar, isMobile, forceLoad]);

  const handleBack = () => {
    navigate('/');
  };

  const handleTryAnyway = () => {
    setForceLoad(true);
  };

  // Check if in development mode for stats display
  const isDev = process.env.NODE_ENV === 'development';

  // Show mobile fallback if on mobile and user hasn't chosen to load anyway
  if (isMobile && !forceLoad) {
    return <MobileFallback onTryAnyway={handleTryAnyway} onGoBack={handleBack} />;
  }

  return (
    <div className="fixed inset-0 top-14 md:top-0 md:left-16 bg-background-dark">
      {/* Back button - hidden on mobile since we have the header back button */}
      <Button
        variant="secondary"
        size="sm"
        icon={ArrowLeft}
        onClick={handleBack}
        className="hidden md:flex absolute top-4 left-4 z-10 backdrop-blur-sm"
      >
        Back to Dashboard
      </Button>

      {/* R3F Factory Scene */}
      <FactoryScene showStats={isDev} className="w-full h-full" />
    </div>
  );
};

export default Factory;
