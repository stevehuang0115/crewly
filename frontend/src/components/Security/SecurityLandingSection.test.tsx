// @vitest-environment jsdom
/**
 * Tests for SecurityLandingSection container component
 *
 * Verifies the full security landing page section renders all
 * sub-components, handles pillar switching, copy button, and
 * accessibility per spec section 2.
 *
 * @module components/Security/SecurityLandingSection.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecurityLandingSection } from './SecurityLandingSection';

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, {
    clipboard: { writeText: mockWriteText },
  });
});

describe('SecurityLandingSection', () => {
  describe('section header', () => {
    it('should render the main heading', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByText(/Security Isn.t a Feature/)).toBeDefined();
    });

    it('should render the subheading', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByText(/Three layers of protection/)).toBeDefined();
    });

    it('should have accessible section with aria-labelledby', () => {
      render(<SecurityLandingSection />);
      const section = screen.getByTestId('security-landing-section');
      expect(section.getAttribute('aria-labelledby')).toBe('security-section-heading');
    });
  });

  describe('pillar cards', () => {
    it('should render all three pillar cards', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByTestId('pillar-card-pty')).toBeDefined();
      expect(screen.getByTestId('pillar-card-storage')).toBeDefined();
      expect(screen.getByTestId('pillar-card-approval')).toBeDefined();
    });

    it('should default to PTY pillar active', () => {
      render(<SecurityLandingSection />);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('aria-label')).toContain('PTY Isolation');
    });

    it('should switch to storage diagram when storage pillar clicked', () => {
      render(<SecurityLandingSection />);
      const seeHowButtons = screen.getAllByRole('button', { name: /see how/i });
      // Storage is the second pillar
      fireEvent.click(seeHowButtons[1]);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('aria-label')).toContain('stored locally');
    });

    it('should switch to approval diagram when approval pillar clicked', () => {
      render(<SecurityLandingSection />);
      const seeHowButtons = screen.getAllByRole('button', { name: /see how/i });
      // Approval is the third pillar
      fireEvent.click(seeHowButtons[2]);
      const diagram = screen.getByTestId('security-arch-diagram');
      expect(diagram.getAttribute('aria-label')).toContain('Granular Tool Approval');
    });
  });

  describe('architecture diagram', () => {
    it('should render the diagram container', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByTestId('security-arch-diagram')).toBeDefined();
    });
  });

  describe('comparison strip', () => {
    it('should render the comparison strip', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByTestId('comparison-strip')).toBeDefined();
    });
  });

  describe('CTA section', () => {
    it('should render the CTA heading', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByText('Get started in one command')).toBeDefined();
    });

    it('should render the npx command', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByText('npx crewly init')).toBeDefined();
    });

    it('should render Copy button', () => {
      render(<SecurityLandingSection />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeDefined();
    });

    it('should copy command to clipboard on click', async () => {
      render(<SecurityLandingSection />);
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
      expect(mockWriteText).toHaveBeenCalledWith('npx crewly init');
    });

    it('should show "Copied!" after clicking copy', async () => {
      render(<SecurityLandingSection />);
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeDefined();
      });
    });

    it('should render GitHub link', () => {
      render(<SecurityLandingSection />);
      const link = screen.getByText('View on GitHub');
      expect(link.getAttribute('href')).toContain('github.com');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    });

    it('should render Docs link', () => {
      render(<SecurityLandingSection />);
      const link = screen.getByText('Read Docs');
      expect(link.getAttribute('href')).toContain('docs.crewlyai.com');
      expect(link.getAttribute('target')).toBe('_blank');
    });
  });

  describe('responsive layout', () => {
    it('should use grid layout for pillar cards', () => {
      render(<SecurityLandingSection />);
      const section = screen.getByTestId('security-landing-section');
      // Pillar cards grid container — first grid inside section
      const grids = section.querySelectorAll('.grid');
      expect(grids.length).toBeGreaterThanOrEqual(1);
      // First grid should have responsive classes
      expect(grids[0].className).toContain('grid-cols-1');
      expect(grids[0].className).toContain('md:grid-cols-3');
    });
  });
});
