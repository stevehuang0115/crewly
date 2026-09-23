import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton } from './Button';
import { focusInitial } from './focus';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
  closable?: boolean;
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}

// Styled inline (not via global CSS) so the modal looks the same wherever
// @crewly/ui is used; the modal-* names stay as hooks for tests and overrides.
const MODAL_SIZE_CLASSES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  xxl: 'max-w-4xl',
};

const FOOTER_ALIGN_CLASSES: Record<'left' | 'center' | 'right' | 'space-between', string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
  'space-between': 'justify-between',
};

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  size = 'md',
  closable = true,
  children,
  className = '',
  'data-testid': testId,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  // Handle escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closable) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden'; // Prevent background scroll
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose, closable]);

  // Focus management
  useEffect(() => {
    if (isOpen && modalRef.current) {
      focusInitial(modalRef.current, (el) => el.classList.contains('modal-close-btn'));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && closable) {
      onClose();
    }
  };

  return (
    <div 
      className="modal-overlay fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center p-4 z-50"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      data-testid={testId}
    >
      <div 
        ref={modalRef}
        className={`modal-content modal-${size} bg-surface-dark border border-border-dark rounded-3xl shadow-lg w-full max-h-[90vh] overflow-y-auto ${MODAL_SIZE_CLASSES[size]} ${className}`}
        onClick={e => e.stopPropagation()}
      >
        {(title || closable) && (
          <div className="modal-header flex items-center justify-between p-6 pb-0">
            {title && <h2 id={titleId} className="modal-title text-xl font-semibold">{title}</h2>}
            {closable && (
              <IconButton
                icon={X}
                onClick={onClose}
                variant="ghost"
                size="sm"
                aria-label="Close modal"
                className="modal-close-btn text-text-secondary-dark hover:text-text-primary-dark"
              />
            )}
          </div>
        )}
        
        <div className="modal-body p-6">
          {children}
        </div>
      </div>
    </div>
  );
};

// Modal Footer component
export interface ModalFooterProps {
  children: React.ReactNode;
  className?: string;
  align?: 'left' | 'center' | 'right' | 'space-between';
}

export const ModalFooter: React.FC<ModalFooterProps> = ({ 
  children, 
  className = '',
  align = 'right'
}) => (
  <div className={`modal-footer modal-footer--${align} flex items-center gap-3 px-6 pb-6 ${FOOTER_ALIGN_CLASSES[align]} ${className}`}>
    {children}
  </div>
);

// Modal Body component (for more control)
export interface ModalBodyProps {
  children: React.ReactNode;
  className?: string;
}

export const ModalBody: React.FC<ModalBodyProps> = ({ 
  children, 
  className = '' 
}) => (
  <div className={`modal-body p-6 ${className}`}>
    {children}
  </div>
);