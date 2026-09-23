import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton } from './Button';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
  closable?: boolean;
  children: React.ReactNode;
  className?: string;
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
  className = ''
}) => {
  const modalRef = useRef<HTMLDivElement>(null);

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
      const focusableElements = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstFocusable = focusableElements[0] as HTMLElement;
      if (firstFocusable) {
        firstFocusable.focus();
      }
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
    >
      <div 
        ref={modalRef}
        className={`modal-content modal-${size} bg-surface-dark border border-border-dark rounded-3xl shadow-lg w-full max-h-[90vh] overflow-y-auto ${MODAL_SIZE_CLASSES[size]} ${className}`}
        onClick={e => e.stopPropagation()}
      >
        {(title || closable) && (
          <div className="modal-header flex items-center justify-between p-6 pb-0">
            {title && <h2 className="modal-title text-xl font-semibold">{title}</h2>}
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