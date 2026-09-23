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
  const baseClasses = 'score-card';
  const variantClasses = `score-card--${variant}`;
  const clickableClasses = isClickable ? 'score-card--clickable' : '';
  
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
        <div className="score-card__label">{label}</div>
        <div className="score-card__value">
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
  const baseClasses = 'score-card-grid';
  const variantClasses = `score-card-grid--${variant}`;
  
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