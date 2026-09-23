import React from 'react';

export interface ScoreCardProps {
  label: string;
  value?: string | number;
  variant?: 'dashboard' | 'horizontal';
  className?: string;
  onClick?: () => void;
  isClickable?: boolean;
  children?: React.ReactNode;
}

export interface ScoreCardGridProps {
  children: React.ReactNode;
  variant?: 'dashboard' | 'horizontal';
  className?: string;
}

export const ScoreCard: React.FC<ScoreCardProps> = ({
  label,
  value,
  variant = 'dashboard',
  className = '',
  onClick,
  isClickable = false,
  children
}) => {
  // Styled inline so the card looks the same outside the OSS app (its
  // index.css used to hold these rules); the BEM names stay as hooks.
  const baseClasses = 'score-card bg-surface-dark border border-border-dark rounded-2xl p-4';
  const variantClasses = `score-card--${variant}`;
  const clickableClasses = isClickable ? 'score-card--clickable cursor-pointer hover:border-primary/50 transition-colors' : '';
  
  const cardClasses = [baseClasses, variantClasses, clickableClasses, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div 
      className={cardClasses}
      onClick={isClickable ? onClick : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      <div className="score-card__content">
        <div className="score-card__label text-sm text-text-secondary-dark">{label}</div>
        <div className="score-card__value text-xl font-semibold mt-1">
          {children || value}
        </div>
      </div>
    </div>
  );
};

export const ScoreCardGrid: React.FC<ScoreCardGridProps> = ({
  children,
  variant = 'dashboard',
  className = ''
}) => {
  const baseClasses = 'score-card-grid grid gap-4 mb-6';
  const variantClasses = `score-card-grid--${variant}${variant === 'horizontal' ? ' grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' : ''}`;
  
  const gridClasses = [baseClasses, variantClasses, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={gridClasses}>
      {children}
    </div>
  );
};

export default ScoreCard;