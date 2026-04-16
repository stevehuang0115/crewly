/**
 * ExpertSelector Component Tests
 *
 * Unit tests for the ExpertSelector dropdown component.
 *
 * @module components/TeamBuilder/ExpertSelector.test
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExpertSelector } from './ExpertSelector';
import { apiService } from '@/services/api.service';
import type { ExpertSummary } from '@/types/expert.types';

// Mock scrollIntoView which is not available in jsdom
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock the API service
vi.mock('@/services/api.service', () => ({
  apiService: {
    getExperts: vi.fn(),
  },
}));

const mockExperts: ExpertSummary[] = [
  {
    id: 'empathetic-resolver',
    name: 'Empathetic Resolver',
    category: 'Customer Support',
    tags: ['empathy', 'retention', 'loyalty'],
    baseRoles: ['support', 'customer-success'],
  },
  {
    id: 'pragmatic-architect',
    name: 'Pragmatic Architect',
    category: 'Development',
    tags: ['YAGNI', 'scalability', 'maintainability'],
    baseRoles: ['architect', 'backend-developer'],
  },
  {
    id: 'viral-alchemist',
    name: 'Viral Alchemist',
    category: 'E-commerce Content',
    tags: ['DTC', 'conversion', 'social-commerce'],
    baseRoles: ['marketing', 'content-strategist'],
  },
];

describe('ExpertSelector', () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getExperts).mockResolvedValue(mockExperts);
  });

  it('renders the component with loading state then options', async () => {
    render(<ExpertSelector value={undefined} onChange={mockOnChange} />);

    expect(screen.getByTestId('expert-selector')).toBeInTheDocument();

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.getByText('Select an expert profile...')).toBeInTheDocument();
    });
  });

  it('shows error state when API fails', async () => {
    vi.mocked(apiService.getExperts).mockRejectedValue(new Error('Network error'));

    render(<ExpertSelector value={undefined} onChange={mockOnChange} />);

    await waitFor(() => {
      expect(screen.getByTestId('expert-selector-error')).toBeInTheDocument();
      expect(screen.getByText('Failed to load experts')).toBeInTheDocument();
    });
  });

  it('shows selected expert details when value is set', async () => {
    render(
      <ExpertSelector
        value="empathetic-resolver"
        onChange={mockOnChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Empathetic Resolver')).toBeInTheDocument();
      expect(screen.getByText('Customer Support')).toBeInTheDocument();
      expect(screen.getByText('empathy')).toBeInTheDocument();
      expect(screen.getByText('retention')).toBeInTheDocument();
      expect(screen.getByText('loyalty')).toBeInTheDocument();
    });
  });

  it('calls onChange with undefined when clear button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <ExpertSelector
        value="empathetic-resolver"
        onChange={mockOnChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('expert-clear-btn')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('expert-clear-btn'));
    expect(mockOnChange).toHaveBeenCalledWith(undefined);
  });

  it('does not show clear button when disabled', async () => {
    render(
      <ExpertSelector
        value="empathetic-resolver"
        onChange={mockOnChange}
        disabled
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Empathetic Resolver')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('expert-clear-btn')).not.toBeInTheDocument();
  });

  it('filters experts by memberRole when provided', async () => {
    render(
      <ExpertSelector
        value={undefined}
        onChange={mockOnChange}
        memberRole="backend-developer"
      />
    );

    // Wait for experts to load
    await waitFor(() => {
      expect(apiService.getExperts).toHaveBeenCalled();
    });

    // Open dropdown to check available options
    const trigger = screen.getByRole('combobox');
    await userEvent.setup().click(trigger);

    // Should show pragmatic-architect (matches backend-developer) but not others
    await waitFor(() => {
      expect(screen.getByText('Pragmatic Architect (Development)')).toBeInTheDocument();
    });
  });

  it('shows all experts when role has no matches', async () => {
    render(
      <ExpertSelector
        value={undefined}
        onChange={mockOnChange}
        memberRole="data-scientist"
      />
    );

    await waitFor(() => {
      expect(apiService.getExperts).toHaveBeenCalled();
    });

    // Open dropdown - should show all experts since no baseRole matches
    const trigger = screen.getByRole('combobox');
    await userEvent.setup().click(trigger);

    await waitFor(() => {
      expect(screen.getByText('Empathetic Resolver (Customer Support)')).toBeInTheDocument();
      expect(screen.getByText('Pragmatic Architect (Development)')).toBeInTheDocument();
      expect(screen.getByText('Viral Alchemist (E-commerce Content)')).toBeInTheDocument();
    });
  });

  it('calls onChange when an expert is selected from dropdown', async () => {
    const user = userEvent.setup();

    render(
      <ExpertSelector
        value={undefined}
        onChange={mockOnChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Select an expert profile...')).toBeInTheDocument();
    });

    // Open dropdown
    await user.click(screen.getByRole('combobox'));

    // Select an expert
    await waitFor(() => {
      expect(screen.getByText('Pragmatic Architect (Development)')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Pragmatic Architect (Development)'));
    expect(mockOnChange).toHaveBeenCalledWith('pragmatic-architect');
  });
});
