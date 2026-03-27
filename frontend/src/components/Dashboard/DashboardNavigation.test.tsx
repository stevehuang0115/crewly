import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { DashboardNavigation } from './DashboardNavigation';

describe('DashboardNavigation', () => {
  const mockOnTabChange = vi.fn();

  beforeEach(() => {
    mockOnTabChange.mockClear();
  });

  it('renders all navigation tabs', () => {
    render(
      <DashboardNavigation 
        activeTab="overview" 
        onTabChange={mockOnTabChange}
      />
    );
    
    expect(screen.getByText('overview')).toBeInTheDocument();
    expect(screen.getByText('teams')).toBeInTheDocument();
    expect(screen.getByText('terminal')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    render(
      <DashboardNavigation 
        activeTab="teams" 
        onTabChange={mockOnTabChange}
      />
    );
    
    const teamsTab = screen.getByText('teams');
    expect(teamsTab).toHaveClass('text-primary', 'border-primary');
  });

  it('calls onTabChange when tab is clicked', () => {
    render(
      <DashboardNavigation 
        activeTab="overview" 
        onTabChange={mockOnTabChange}
      />
    );
    
    fireEvent.click(screen.getByText('teams'));
    expect(mockOnTabChange).toHaveBeenCalledWith('teams');
  });

  it('applies inactive styles to non-active tabs', () => {
    render(
      <DashboardNavigation 
        activeTab="overview" 
        onTabChange={mockOnTabChange}
      />
    );
    
    const teamsTab = screen.getByText('teams');
    expect(teamsTab).toHaveClass('border-transparent', 'text-gray-500');
  });
});