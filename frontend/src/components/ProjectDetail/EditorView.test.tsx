import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { EditorView } from './EditorView';
import { Project } from '../../types';
import { FileTreeNode } from './types';

// Mock the Button component
vi.mock('@crewly/ui', () => ({
  Button: ({ children, onClick, icon: Icon, ...props }: any) => (
    <button onClick={onClick} data-testid="mock-button" {...props}>
      {Icon && <span data-testid="button-icon" />}
      {children}
    </button>
  ),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('EditorView', () => {
  const mockProject: Project = {
    id: 'test-project-id',
    name: 'Test Project',
    description: 'A test project',
    path: '/path/to/test/project',
    teams: {},
    status: 'active',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
  };

  const mockFiles: FileTreeNode[] = [
    {
      name: 'src',
      path: 'src',
      type: 'folder',
      icon: '📁',
      children: [
        {
          name: 'index.js',
          path: 'src/index.js',
          type: 'file',
          icon: '📄',
        },
      ],
    },
    {
      name: '.crewly',
      path: '.crewly',
      type: 'folder',
      icon: '📁',
      children: [
        {
          name: 'initial_goal.md',
          path: '.crewly/initial_goal.md',
          type: 'file',
          icon: '📝',
        },
      ],
    },
  ];

  const defaultProps = {
    project: mockProject,
    selectedFile: null,
    onFileSelect: vi.fn(),
    setIsMarkdownEditorOpen: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Component Rendering', () => {
    it('renders the editor view with file tree and project info panels', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      await act(async () => {
        render(<EditorView {...defaultProps} />);
      });

      expect(screen.getByText('Project Files')).toBeInTheDocument();
      expect(screen.getByText('Project Information')).toBeInTheDocument();
      expect(screen.getByText(mockProject.name)).toBeInTheDocument();
      expect(screen.getByText(mockProject.path)).toBeInTheDocument();
    });

    it('displays Edit Specs button in project info panel', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      await act(async () => {
        render(<EditorView {...defaultProps} />);
      });

      const editSpecsButton = screen.getByText('Edit Specs');
      expect(editSpecsButton).toBeInTheDocument();
    });

    it('renders project status and description when available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      await act(async () => {
        render(<EditorView {...defaultProps} />);
      });

      expect(screen.getByText(mockProject.status)).toBeInTheDocument();
      expect(screen.getByText(mockProject.description!)).toBeInTheDocument();
    });
  });

  describe('File Tree Functionality', () => {
    it('loads and displays project files on mount', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      await act(async () => {
        render(<EditorView {...defaultProps} />);
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files?depth=4&includeDotFiles=true`
        );
      });

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
        expect(screen.getByText('.crewly')).toBeInTheDocument();
      });
    });

    it('expands and collapses folders when clicked', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      render(<EditorView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument();
      });

      // Click on folder to expand
      const srcFolder = screen.getByText('src').closest('.file-item');
      expect(srcFolder).toBeInTheDocument();
      
      fireEvent.click(srcFolder!);

      // Check if folder expanded (child file should be visible)
      await waitFor(() => {
        expect(screen.getByText('index.js')).toBeInTheDocument();
      });
    });

    it('auto-expands .crewly folder', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      render(<EditorView {...defaultProps} />);

      // .crewly should be auto-expanded and show its child file
      await waitFor(() => {
        expect(screen.getByText('initial_goal.md')).toBeInTheDocument();
      });
    });

    it('calls onFileSelect when file is clicked', async () => {
      const onFileSelect = vi.fn();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      render(<EditorView {...defaultProps} onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('initial_goal.md')).toBeInTheDocument();
      });

      const goalFile = screen.getByText('initial_goal.md').closest('.file-item');
      fireEvent.click(goalFile!);

      expect(onFileSelect).toHaveBeenCalledWith('.crewly/initial_goal.md');
    });
  });

  describe('File Content Loading', () => {
    it('loads and displays file content when file is selected', async () => {
      const selectedFile = '.crewly/initial_goal.md';
      const fileContent = '# Project Goal\n\nThis is the main goal.';

      // Mock the files API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      // Mock the file content API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { content: fileContent },
        }),
      });

      render(<EditorView {...defaultProps} selectedFile={selectedFile} />);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/file-content?filePath=${encodeURIComponent(selectedFile)}`
        );
      });

      await waitFor(() => {
        expect(screen.getByText(fileContent)).toBeInTheDocument();
      });

      // Should show file header
      expect(screen.getByText(selectedFile)).toBeInTheDocument();
    });

    it('displays loading state while loading file content', async () => {
      const selectedFile = '.crewly/initial_goal.md';

      // Mock the files API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      // Mock the file content API call with delay
      mockFetch.mockImplementationOnce(() => 
        new Promise(resolve => 
          setTimeout(() => 
            resolve({
              ok: true,
              json: async () => ({ data: { content: 'File content' } }),
            }), 100)
        )
      );

      render(<EditorView {...defaultProps} selectedFile={selectedFile} />);

      // Should show loading state
      expect(screen.getByText('Loading file content...')).toBeInTheDocument();
    });

    it('displays error state when file loading fails', async () => {
      const selectedFile = '.crewly/initial_goal.md';

      // Mock the files API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      // Mock the file content API call to fail
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: 'File not found',
        }),
      });

      render(<EditorView {...defaultProps} selectedFile={selectedFile} />);

      await waitFor(() => {
        expect(screen.getByText('Error: File not found')).toBeInTheDocument();
      });
    });
  });

  describe('Monaco Editor Integration', () => {
    it('handles file selection for potential Monaco integration', async () => {
      // Mock the files API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      const onFileSelect = vi.fn();
      render(<EditorView {...defaultProps} onFileSelect={onFileSelect} />);

      await waitFor(() => {
        expect(screen.getByText('initial_goal.md')).toBeInTheDocument();
      });

      // Click on a file
      const goalFile = screen.getByText('initial_goal.md').closest('.file-item');
      fireEvent.click(goalFile!);

      // Verify file selection callback
      expect(onFileSelect).toHaveBeenCalledWith('.crewly/initial_goal.md');
    });

    it('provides code viewer structure for Monaco integration', async () => {
      const selectedFile = 'src/index.js';
      const jsContent = 'console.log("Hello World");';

      // Mock the files API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      // Mock the file content API call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { content: jsContent },
        }),
      });

      render(<EditorView {...defaultProps} selectedFile={selectedFile} />);

      await waitFor(() => {
        const codeViewer = screen.getByText(jsContent).closest('.code-viewer');
        expect(codeViewer).toBeInTheDocument();
        expect(codeViewer?.tagName).toBe('PRE');
      });
    });
  });

  describe('User Interactions', () => {
    it('calls setIsMarkdownEditorOpen when Edit Specs button is clicked', async () => {
      const setIsMarkdownEditorOpen = vi.fn();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            files: mockFiles,
            projectPath: mockProject.path,
            resolvedPath: mockProject.path,
          },
        }),
      });

      await act(async () => {
        render(<EditorView {...defaultProps} setIsMarkdownEditorOpen={setIsMarkdownEditorOpen} />);
      });

      const editSpecsButton = screen.getByText('Edit Specs');
      fireEvent.click(editSpecsButton);

      expect(setIsMarkdownEditorOpen).toHaveBeenCalledWith(true);
    });

    it('clears file content when selectedFile is null', async () => {
      const { rerender } = await act(async () => {
        return render(<EditorView {...defaultProps} selectedFile="test.txt" />);
      });

      // Mock the file loading
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { content: 'Some content' } }),
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2); // files + content
      });

      // Clear selection
      await act(async () => {
        rerender(<EditorView {...defaultProps} selectedFile={null} />);
      });

      // Should show project info instead of file content
      expect(screen.getByText('Project Information')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('handles API error when loading project files', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      await act(async () => {
        render(<EditorView {...defaultProps} />);
      });

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          'Error loading project files:',
          500
        );
      });

      consoleSpy.mockRestore();
    });

    it('handles network error when loading files', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      await act(async () => {
        render(<EditorView {...defaultProps} />);
      });

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          'Error loading project files:',
          expect.any(Error)
        );
      });

      consoleSpy.mockRestore();
    });
  });
});