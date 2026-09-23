import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { Modal, ModalFooter, ModalBody } from './Modal';

describe('Modal Component', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    children: <div>Modal content</div>
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any lingering body styles
    document.body.style.overflow = 'unset';
  });

  describe('Basic Rendering', () => {
    it('should render modal when isOpen is true', () => {
      render(<Modal {...defaultProps} />);
      
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Modal content')).toBeInTheDocument();
    });

    it('should not render modal when isOpen is false', () => {
      render(<Modal {...defaultProps} isOpen={false} />);
      
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
    });

    it('should render with title when provided', () => {
      render(<Modal {...defaultProps} title="Test Modal Title" />);
      
      expect(screen.getByText('Test Modal Title')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Test Modal Title');
    });

    it('should render without title when not provided', () => {
      render(<Modal {...defaultProps} />);
      
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });
  });

  describe('Size Variants', () => {
    const sizes = ['sm', 'md', 'lg', 'xl'] as const;

    sizes.forEach(size => {
      it(`should apply ${size} size class`, () => {
        render(<Modal {...defaultProps} size={size} />);
        
        const modalContent = document.querySelector('.modal-content');
        expect(modalContent).toHaveClass(`modal-${size}`);
      });
    });

    it('should apply default md size when no size is specified', () => {
      render(<Modal {...defaultProps} />);
      
      const modalContent = document.querySelector('.modal-content');
      expect(modalContent).toHaveClass('modal-md');
    });
  });

  describe('Close Button', () => {
    it('should render close button when closable is true (default)', () => {
      render(<Modal {...defaultProps} title="Test Modal" />);
      
      const closeButton = screen.getByRole('button', { name: 'Close modal' });
      expect(closeButton).toBeInTheDocument();
    });

    it('should not render close button when closable is false', () => {
      render(<Modal {...defaultProps} title="Test Modal" closable={false} />);
      
      expect(screen.queryByRole('button', { name: 'Close modal' })).not.toBeInTheDocument();
    });

    it('should call onClose when close button is clicked', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} title="Test Modal" />);
      
      const closeButton = screen.getByRole('button', { name: 'Close modal' });
      fireEvent.click(closeButton);
      
      expect(onCloseMock).toHaveBeenCalledTimes(1);
    });

    it('should render close button when no title but closable defaults to true', () => {
      render(<Modal {...defaultProps} />);

      // closable defaults to true, so close button is rendered even without title
      const closeButton = screen.getByRole('button', { name: 'Close modal' });
      expect(closeButton).toBeInTheDocument();
    });

    it('should render close button when no title but closable is explicitly true', () => {
      render(<Modal {...defaultProps} closable={true} />);
      
      const closeButton = screen.getByRole('button', { name: 'Close modal' });
      expect(closeButton).toBeInTheDocument();
    });
  });

  describe('Backdrop Interaction', () => {
    it('should call onClose when backdrop is clicked and closable is true', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} />);
      
      const overlay = document.querySelector('.modal-overlay');
      fireEvent.click(overlay!);
      
      expect(onCloseMock).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose when backdrop is clicked and closable is false', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} closable={false} />);
      
      const overlay = document.querySelector('.modal-overlay');
      fireEvent.click(overlay!);
      
      expect(onCloseMock).not.toHaveBeenCalled();
    });

    it('should not call onClose when modal content is clicked', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} />);
      
      const modalContent = document.querySelector('.modal-content');
      fireEvent.click(modalContent!);
      
      expect(onCloseMock).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard Interaction', () => {
    it('should call onClose when Escape key is pressed and closable is true', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} />);
      
      fireEvent.keyDown(document, { key: 'Escape' });
      
      expect(onCloseMock).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose when Escape key is pressed and closable is false', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} closable={false} />);
      
      fireEvent.keyDown(document, { key: 'Escape' });
      
      expect(onCloseMock).not.toHaveBeenCalled();
    });

    it('should not call onClose when other keys are pressed', () => {
      const onCloseMock = vi.fn();
      render(<Modal {...defaultProps} onClose={onCloseMock} />);
      
      fireEvent.keyDown(document, { key: 'Enter' });
      fireEvent.keyDown(document, { key: 'Space' });
      fireEvent.keyDown(document, { key: 'Tab' });
      
      expect(onCloseMock).not.toHaveBeenCalled();
    });

    it('should clean up event listeners when modal is closed', () => {
      const onCloseMock = vi.fn();
      const { rerender } = render(<Modal {...defaultProps} onClose={onCloseMock} />);
      
      // Verify listener is active
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onCloseMock).toHaveBeenCalledTimes(1);
      
      // Close modal
      rerender(<Modal {...defaultProps} onClose={onCloseMock} isOpen={false} />);
      
      // Verify listener is removed
      onCloseMock.mockClear();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onCloseMock).not.toHaveBeenCalled();
    });
  });

  describe('Body Scroll Management', () => {
    it('should prevent body scroll when modal is open', () => {
      render(<Modal {...defaultProps} />);
      
      expect(document.body.style.overflow).toBe('hidden');
    });

    it('should restore body scroll when modal is closed', () => {
      const { rerender } = render(<Modal {...defaultProps} />);
      
      expect(document.body.style.overflow).toBe('hidden');
      
      rerender(<Modal {...defaultProps} isOpen={false} />);
      
      expect(document.body.style.overflow).toBe('unset');
    });

    it('should restore body scroll on unmount', () => {
      const { unmount } = render(<Modal {...defaultProps} />);
      
      expect(document.body.style.overflow).toBe('hidden');
      
      unmount();
      
      expect(document.body.style.overflow).toBe('unset');
    });
  });

  describe('Focus Management', () => {
    it('should focus first focusable element when modal opens', async () => {
      render(
        <Modal {...defaultProps} closable={false}>
          <div>
            <button>First Button</button>
            <button>Second Button</button>
          </div>
        </Modal>
      );

      await waitFor(() => {
        expect(screen.getByText('First Button')).toHaveFocus();
      });
    });

    it('should focus close button if it is the first focusable element', async () => {
      render(
        <Modal {...defaultProps} title="Test Modal">
          <div>No focusable elements</div>
        </Modal>
      );
      
      await waitFor(() => {
        const closeButton = screen.getByRole('button', { name: 'Close modal' });
        expect(closeButton).toHaveFocus();
      });
    });

    it('should handle modal without focusable elements gracefully', async () => {
      render(
        <Modal {...defaultProps}>
          <div>Just text content</div>
        </Modal>
      );
      
      // Should not throw an error
      await waitFor(() => {
        expect(screen.getByText('Just text content')).toBeInTheDocument();
      });
    });
  });

  describe('Custom Classes', () => {
    it('should apply custom className to modal content', () => {
      render(<Modal {...defaultProps} className="custom-modal-class" />);
      
      const modalContent = document.querySelector('.modal-content');
      expect(modalContent).toHaveClass('custom-modal-class');
    });

    it('should combine custom className with size class', () => {
      render(<Modal {...defaultProps} size="lg" className="custom-modal-class" />);
      
      const modalContent = document.querySelector('.modal-content');
      expect(modalContent).toHaveClass('modal-lg', 'custom-modal-class');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', () => {
      render(<Modal {...defaultProps} />);
      
      const overlay = screen.getByRole('dialog');
      expect(overlay).toHaveAttribute('aria-modal', 'true');
    });

    it('should have accessible modal title', () => {
      render(<Modal {...defaultProps} title="Accessible Modal" />);
      
      const title = screen.getByRole('heading', { level: 2 });
      expect(title).toHaveTextContent('Accessible Modal');
      expect(title).toHaveClass('modal-title');
    });

    it('should have accessible close button', () => {
      render(<Modal {...defaultProps} title="Test Modal" />);
      
      const closeButton = screen.getByRole('button', { name: 'Close modal' });
      expect(closeButton).toBeInTheDocument();
    });
  });

  describe('Complex Interactions', () => {
    it('should handle multiple modals correctly', () => {
      const onClose1 = vi.fn();
      const onClose2 = vi.fn();
      
      render(
        <div>
          <Modal isOpen={true} onClose={onClose1} title="First Modal">
            <div>First modal content</div>
          </Modal>
          <Modal isOpen={true} onClose={onClose2} title="Second Modal">
            <div>Second modal content</div>
          </Modal>
        </div>
      );
      
      expect(screen.getByText('First modal content')).toBeInTheDocument();
      expect(screen.getByText('Second modal content')).toBeInTheDocument();
      
      // Both modals should be rendered
      expect(screen.getAllByRole('dialog')).toHaveLength(2);
    });

    it('should handle rapid open/close correctly', async () => {
      const onCloseMock = vi.fn();
      const { rerender } = render(<Modal {...defaultProps} onClose={onCloseMock} />);
      
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      
      // Close modal
      rerender(<Modal {...defaultProps} onClose={onCloseMock} isOpen={false} />);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      
      // Reopen modal
      rerender(<Modal {...defaultProps} onClose={onCloseMock} isOpen={true} />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('Event Propagation', () => {
    it('should stop event propagation on modal content click', () => {
      const overlayClickHandler = vi.fn();
      const contentClickHandler = vi.fn();
      
      render(
        <div onClick={overlayClickHandler}>
          <Modal {...defaultProps}>
            <div onClick={contentClickHandler}>Modal content</div>
          </Modal>
        </div>
      );
      
      // Click on modal content
      fireEvent.click(screen.getByText('Modal content'));
      
      expect(contentClickHandler).toHaveBeenCalledTimes(1);
      // Should not propagate to overlay
      expect(overlayClickHandler).not.toHaveBeenCalled();
    });
  });
});

describe('ModalFooter Component', () => {
  describe('Basic Rendering', () => {
    it('should render footer content', () => {
      render(
        <ModalFooter>
          <button>Cancel</button>
          <button>Save</button>
        </ModalFooter>
      );
      
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeInTheDocument();
    });

    it('should apply default right alignment', () => {
      render(
        <ModalFooter>
          <button>Action</button>
        </ModalFooter>
      );
      
      const footer = document.querySelector('.modal-footer');
      expect(footer).toHaveClass('modal-footer--right');
    });
  });

  describe('Alignment Options', () => {
    const alignments = ['left', 'center', 'right', 'space-between'] as const;

    alignments.forEach(alignment => {
      it(`should apply ${alignment} alignment`, () => {
        render(
          <ModalFooter align={alignment}>
            <button>Action</button>
          </ModalFooter>
        );
        
        const footer = document.querySelector('.modal-footer');
        expect(footer).toHaveClass(`modal-footer--${alignment}`);
      });
    });
  });

  describe('Custom Classes', () => {
    it('should apply custom className', () => {
      render(
        <ModalFooter className="custom-footer-class">
          <button>Action</button>
        </ModalFooter>
      );
      
      const footer = document.querySelector('.modal-footer');
      expect(footer).toHaveClass('custom-footer-class');
    });

    it('should combine custom className with alignment class', () => {
      render(
        <ModalFooter align="center" className="custom-footer-class">
          <button>Action</button>
        </ModalFooter>
      );
      
      const footer = document.querySelector('.modal-footer');
      expect(footer).toHaveClass('modal-footer--center', 'custom-footer-class');
    });
  });
});

describe('ModalBody Component', () => {
  describe('Basic Rendering', () => {
    it('should render body content', () => {
      render(
        <ModalBody>
          <p>Modal body content</p>
        </ModalBody>
      );
      
      expect(screen.getByText('Modal body content')).toBeInTheDocument();
    });

    it('should apply modal-body class', () => {
      render(
        <ModalBody>
          <p>Content</p>
        </ModalBody>
      );
      
      const body = document.querySelector('.modal-body');
      expect(body).toBeInTheDocument();
    });
  });

  describe('Custom Classes', () => {
    it('should apply custom className', () => {
      render(
        <ModalBody className="custom-body-class">
          <p>Content</p>
        </ModalBody>
      );
      
      const body = document.querySelector('.modal-body');
      expect(body).toHaveClass('modal-body', 'custom-body-class');
    });
  });
});