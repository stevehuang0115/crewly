/**
 * Tests for SourceDrawer component.
 *
 * @module components/PortalOnboarding/SourceDrawer.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SourceDrawer } from './SourceDrawer';

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  fieldLabel: 'Business Name',
  confidence: 'high' as const,
  sourceUrls: ['https://example.com/', 'https://example.com/about'],
  sourceSnippet: 'Example Corp is a leading provider',
  extractionMethod: 'llm_text' as const,
};

describe('SourceDrawer', () => {
  it('renders nothing when closed', () => {
    render(<SourceDrawer {...defaultProps} isOpen={false} />);
    expect(screen.queryByTestId('source-drawer')).not.toBeInTheDocument();
  });

  it('renders when open', () => {
    render(<SourceDrawer {...defaultProps} />);
    expect(screen.getByTestId('source-drawer')).toBeInTheDocument();
  });

  it('displays "Why we think this" heading', () => {
    render(<SourceDrawer {...defaultProps} />);
    expect(screen.getByText('Why we think this')).toBeInTheDocument();
  });

  it('shows confidence pill', () => {
    render(<SourceDrawer {...defaultProps} />);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('shows source snippet', () => {
    render(<SourceDrawer {...defaultProps} />);
    expect(
      screen.getByText('Example Corp is a leading provider')
    ).toBeInTheDocument();
  });

  it('renders source URLs as links', () => {
    render(<SourceDrawer {...defaultProps} />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/');
    expect(links[1]).toHaveAttribute('href', 'https://example.com/about');
  });

  it('shows extraction method label', () => {
    render(<SourceDrawer {...defaultProps} />);
    expect(screen.getByText('Extracted from page text')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<SourceDrawer {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('source-drawer-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has accessible region label', () => {
    render(<SourceDrawer {...defaultProps} />);
    expect(
      screen.getByRole('region', { name: /source details for business name/i })
    ).toBeInTheDocument();
  });

  it('handles empty source URLs', () => {
    render(<SourceDrawer {...defaultProps} sourceUrls={[]} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('handles missing snippet', () => {
    render(<SourceDrawer {...defaultProps} sourceSnippet={undefined} />);
    expect(
      screen.queryByText('Supporting snippet:')
    ).not.toBeInTheDocument();
  });
});
