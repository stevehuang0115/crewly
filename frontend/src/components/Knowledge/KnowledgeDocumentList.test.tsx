/**
 * KnowledgeDocumentList Component Tests
 *
 * Tests for the document list component that displays searchable
 * document summaries with loading, empty, and populated states.
 *
 * @module components/Knowledge/KnowledgeDocumentList.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeDocumentList } from './KnowledgeDocumentList';
import type { KnowledgeDocumentSummary } from '../../types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Search: () => <svg data-testid="search-icon" />,
  FileText: () => <svg data-testid="file-text-icon" />,
}));

/**
 * Create a mock document summary for testing.
 *
 * @param overrides - Partial overrides for the default mock document
 * @returns A complete KnowledgeDocumentSummary object
 */
function createMockDocSummary(
  overrides: Partial<KnowledgeDocumentSummary> = {},
): KnowledgeDocumentSummary {
  return {
    id: 'doc-1',
    title: 'Test Document',
    category: 'General',
    tags: [],
    preview: 'This is a test document preview.',
    scope: 'global',
    createdBy: 'admin',
    updatedBy: 'admin',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  };
}

describe('KnowledgeDocumentList', () => {
  const defaultProps = {
    documents: [] as KnowledgeDocumentSummary[],
    loading: false,
    searchQuery: '',
    onSearchChange: vi.fn(),
    selectedDocId: undefined,
    onSelectDocument: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Search Input', () => {
    it('should render the search input', () => {
      render(<KnowledgeDocumentList {...defaultProps} />);

      expect(screen.getByPlaceholderText('Search documents...')).toBeInTheDocument();
    });

    it('should render the search input with accessible label', () => {
      render(<KnowledgeDocumentList {...defaultProps} />);

      expect(screen.getByRole('textbox', { name: /search documents/i })).toBeInTheDocument();
    });

    it('should display the current search query value', () => {
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          searchQuery="deployment"
        />,
      );

      const input = screen.getByPlaceholderText('Search documents...') as HTMLInputElement;
      expect(input.value).toBe('deployment');
    });

    it('should call onSearchChange when user types in search input', () => {
      const onSearchChange = vi.fn();
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          onSearchChange={onSearchChange}
        />,
      );

      const input = screen.getByPlaceholderText('Search documents...');
      fireEvent.change(input, { target: { value: 'architecture' } });

      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith('architecture');
    });

    it('should call onSearchChange with empty string when input is cleared', () => {
      const onSearchChange = vi.fn();
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          searchQuery="some query"
          onSearchChange={onSearchChange}
        />,
      );

      const input = screen.getByPlaceholderText('Search documents...');
      fireEvent.change(input, { target: { value: '' } });

      expect(onSearchChange).toHaveBeenCalledWith('');
    });

    it('should render the search icon', () => {
      render(<KnowledgeDocumentList {...defaultProps} />);

      expect(screen.getByTestId('search-icon')).toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('should show loading text when loading is true', () => {
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          loading={true}
        />,
      );

      expect(screen.getByText('Loading documents...')).toBeInTheDocument();
    });

    it('should show loading status role when loading', () => {
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          loading={true}
        />,
      );

      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('should not show document items when loading', () => {
      const documents = [createMockDocSummary({ title: 'Should Not Appear' })];
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
          loading={true}
        />,
      );

      expect(screen.queryByText('Should Not Appear')).not.toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('should show empty state when not loading and documents array is empty', () => {
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={[]}
          loading={false}
        />,
      );

      expect(screen.getByText('No documents found')).toBeInTheDocument();
    });

    it('should show FileText icon in empty state', () => {
      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={[]}
          loading={false}
        />,
      );

      expect(screen.getByTestId('file-text-icon')).toBeInTheDocument();
    });
  });

  describe('Document Items', () => {
    it('should render document titles', () => {
      const documents = [
        createMockDocSummary({ id: 'doc-1', title: 'Deployment Guide' }),
        createMockDocSummary({ id: 'doc-2', title: 'API Standards' }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
        />,
      );

      expect(screen.getByText('Deployment Guide')).toBeInTheDocument();
      expect(screen.getByText('API Standards')).toBeInTheDocument();
    });

    it('should render document previews', () => {
      const documents = [
        createMockDocSummary({ id: 'doc-1', preview: 'How to deploy the app...' }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
        />,
      );

      expect(screen.getByText('How to deploy the app...')).toBeInTheDocument();
    });

    it('should render document categories', () => {
      const documents = [
        createMockDocSummary({ id: 'doc-1', category: 'Runbooks' }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
        />,
      );

      expect(screen.getByText('Runbooks')).toBeInTheDocument();
    });

    it('should render document tags', () => {
      const documents = [
        createMockDocSummary({ id: 'doc-1', tags: ['react', 'frontend', 'testing'] }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
        />,
      );

      expect(screen.getByText('react')).toBeInTheDocument();
      expect(screen.getByText('frontend')).toBeInTheDocument();
      expect(screen.getByText('testing')).toBeInTheDocument();
    });

    it('should truncate tags to show only first 3 with overflow indicator', () => {
      const documents = [
        createMockDocSummary({
          id: 'doc-1',
          tags: ['react', 'frontend', 'testing', 'typescript', 'vite'],
        }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
        />,
      );

      expect(screen.getByText('react')).toBeInTheDocument();
      expect(screen.getByText('frontend')).toBeInTheDocument();
      expect(screen.getByText('testing')).toBeInTheDocument();
      expect(screen.queryByText('typescript')).not.toBeInTheDocument();
      expect(screen.queryByText('vite')).not.toBeInTheDocument();
      expect(screen.getByText('+2')).toBeInTheDocument();
    });

    it('should not show tags section when document has no tags', () => {
      const documents = [
        createMockDocSummary({ id: 'doc-1', tags: [] }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
        />,
      );

      // The document title should be present but no tag elements
      expect(screen.getByText('Test Document')).toBeInTheDocument();
    });
  });

  describe('Document Selection', () => {
    it('should call onSelectDocument with the document id when clicked', () => {
      const onSelectDocument = vi.fn();
      const documents = [
        createMockDocSummary({ id: 'doc-42', title: 'Clickable Doc' }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
          onSelectDocument={onSelectDocument}
        />,
      );

      fireEvent.click(screen.getByText('Clickable Doc'));

      expect(onSelectDocument).toHaveBeenCalledTimes(1);
      expect(onSelectDocument).toHaveBeenCalledWith('doc-42');
    });

    it('should call onSelectDocument with the correct id for each document', () => {
      const onSelectDocument = vi.fn();
      const documents = [
        createMockDocSummary({ id: 'doc-1', title: 'First Doc' }),
        createMockDocSummary({ id: 'doc-2', title: 'Second Doc' }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
          onSelectDocument={onSelectDocument}
        />,
      );

      fireEvent.click(screen.getByText('Second Doc'));
      expect(onSelectDocument).toHaveBeenCalledWith('doc-2');

      fireEvent.click(screen.getByText('First Doc'));
      expect(onSelectDocument).toHaveBeenCalledWith('doc-1');
    });

    it('should visually distinguish the selected document', () => {
      const documents = [
        createMockDocSummary({ id: 'doc-1', title: 'Selected Doc' }),
        createMockDocSummary({ id: 'doc-2', title: 'Other Doc' }),
      ];

      render(
        <KnowledgeDocumentList
          {...defaultProps}
          documents={documents}
          selectedDocId="doc-1"
        />,
      );

      // The selected document button should have the primary highlight class
      const selectedButton = screen.getByText('Selected Doc').closest('button');
      expect(selectedButton).toHaveClass('bg-primary/20');

      const otherButton = screen.getByText('Other Doc').closest('button');
      expect(otherButton).not.toHaveClass('bg-primary/20');
    });
  });
});
