import React from 'react';
import { LoadingSpinner as UiLoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { LoadingSpinnerProps } from './types';

/**
 * Full-screen loading state for the legacy dashboard.
 *
 * @param props - Optional message and extra classes for the outer container
 * @returns A centred spinner with a message
 */
export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  message = 'Loading Crewly...',
  className = ''
}) => {
  return (
    <div className={`min-h-screen bg-background-dark flex items-center justify-center ${className}`}>
      <UiLoadingSpinner size="xl" text={message} />
    </div>
  );
};
