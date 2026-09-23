/**
 * HierarchyTreeView Component Tests
 *
 * @module components/Hierarchy/HierarchyTreeView.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  HierarchyTreeView,
  buildHierarchyTree,
  getStatusColor,
  getWorkingStatusLabel,
} from './HierarchyTreeView';
import type { TeamMember } from '@/types';

// =============================================================================
// Test data helpers
// =============================================================================

function createTestMember(overrides?: Partial<TeamMember>): TeamMember {
  return {
    id: 'member-1',
    name: 'Dev Worker',
    sessionName: 'dev-session-1',
    role: 'developer',
    systemPrompt: 'You are a developer',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2026-03-06T10:00:00.000Z',
    updatedAt: '2026-03-06T10:00:00.000Z',
    ...overrides,
  };
}

function createTestHierarchy(): TeamMember[] {
  return [
    createTestMember({
      id: 'orc',
      name: 'Orchestrator',
      role: 'orchestrator',
      hierarchyLevel: 0,
      parentMemberId: undefined,
      canDelegate: true,
      subordinateIds: ['tl-1'],
    }),
    createTestMember({
      id: 'tl-1',
      name: 'Frontend TL',
      role: 'team-leader',
      hierarchyLevel: 1,
      parentMemberId: 'orc',
      canDelegate: true,
      subordinateIds: ['dev-1', 'dev-2'],
    }),
    createTestMember({
      id: 'dev-1',
      name: 'Dev1',
      role: 'developer',
      agentStatus: 'active',
      workingStatus: 'in_progress',
      hierarchyLevel: 2,
      parentMemberId: 'tl-1',
    }),
    createTestMember({
      id: 'dev-2',
      name: 'Dev2',
      role: 'developer',
      agentStatus: 'inactive',
      workingStatus: 'idle',
      hierarchyLevel: 2,
      parentMemberId: 'tl-1',
    }),
  ];
}

// =============================================================================
// Unit tests: helper functions
// =============================================================================

describe('buildHierarchyTree', () => {
  it('should return empty array for empty members', () => {
    expect(buildHierarchyTree([])).toEqual([]);
  });

  it('should build single root node', () => {
    const members = [createTestMember({ id: 'root', parentMemberId: undefined })];
    const tree = buildHierarchyTree(members);
    expect(tree).toHaveLength(1);
    expect(tree[0].member.id).toBe('root');
    expect(tree[0].children).toHaveLength(0);
    expect(tree[0].depth).toBe(0);
  });

  it('should build 3-level hierarchy correctly', () => {
    const members = createTestHierarchy();
    const tree = buildHierarchyTree(members);

    expect(tree).toHaveLength(1);
    expect(tree[0].member.id).toBe('orc');
    expect(tree[0].depth).toBe(0);

    // TL is child of orchestrator
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].member.id).toBe('tl-1');
    expect(tree[0].children[0].depth).toBe(1);

    // Workers are children of TL
    expect(tree[0].children[0].children).toHaveLength(2);
    expect(tree[0].children[0].children[0].member.id).toBe('dev-1');
    expect(tree[0].children[0].children[0].depth).toBe(2);
    expect(tree[0].children[0].children[1].member.id).toBe('dev-2');
  });

  it('should handle flat team (no parentMemberId) as multiple roots', () => {
    const members = [
      createTestMember({ id: 'm1', name: 'A', parentMemberId: undefined }),
      createTestMember({ id: 'm2', name: 'B', parentMemberId: undefined }),
    ];
    const tree = buildHierarchyTree(members);
    expect(tree).toHaveLength(2);
  });
});

describe('getStatusColor', () => {
  it('should return green for active', () => {
    expect(getStatusColor('active')).toBe('bg-emerald-400');
  });

  it('should return yellow for starting', () => {
    expect(getStatusColor('starting')).toBe('bg-yellow-400');
  });

  it('should return the neutral token for inactive', () => {
    expect(getStatusColor('inactive')).toBe('bg-text-secondary-dark');
  });

  it('should return the neutral token for unknown status', () => {
    expect(getStatusColor('unknown')).toBe('bg-text-secondary-dark');
  });
});

describe('getWorkingStatusLabel', () => {
  it('should return "Working" for in_progress', () => {
    expect(getWorkingStatusLabel('in_progress')).toBe('Working');
  });

  it('should capitalize "idle"', () => {
    expect(getWorkingStatusLabel('idle')).toBe('Idle');
  });
});

// =============================================================================
// Component tests
// =============================================================================

describe('HierarchyTreeView', () => {
  describe('Rendering', () => {
    it('should show empty message when no members', () => {
      render(<HierarchyTreeView members={[]} />);
      expect(screen.getByText('No team members to display.')).toBeInTheDocument();
    });

    it('should render all members in the hierarchy', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
      expect(screen.getByText('Frontend TL')).toBeInTheDocument();
      // TL nodes with canDelegate are expanded by default
      expect(screen.getByText('Dev1')).toBeInTheDocument();
      expect(screen.getByText('Dev2')).toBeInTheDocument();
    });

    it('should render role labels for each node', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      expect(screen.getByText('orchestrator')).toBeInTheDocument();
      expect(screen.getByText('team-leader')).toBeInTheDocument();
      // Dev nodes show 'developer' role
      expect(screen.getAllByText('developer')).toHaveLength(2);
    });

    it('should render working status badges', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      expect(screen.getByText('Working')).toBeInTheDocument();
      expect(screen.getAllByText('Idle')).toHaveLength(3);
    });

    it('should have tree role and treeitem roles', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      expect(screen.getByRole('tree')).toBeInTheDocument();
      expect(screen.getAllByRole('treeitem').length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Expand/Collapse', () => {
    it('should collapse a TL node when toggle is clicked', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      // Dev1 is visible initially (TL is expanded by default)
      expect(screen.getByText('Dev1')).toBeInTheDocument();

      // Find and click the collapse button for TL
      const collapseButtons = screen.getAllByLabelText('Collapse');
      expect(collapseButtons.length).toBeGreaterThanOrEqual(1);

      // Click the TL's collapse button (the second one — first is orchestrator)
      fireEvent.click(collapseButtons[collapseButtons.length - 1]);

      // Dev1 should no longer be visible
      expect(screen.queryByText('Dev1')).not.toBeInTheDocument();
    });

    it('should expand a collapsed node when toggle is clicked', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      // Collapse TL first
      const collapseButtons = screen.getAllByLabelText('Collapse');
      fireEvent.click(collapseButtons[collapseButtons.length - 1]);
      expect(screen.queryByText('Dev1')).not.toBeInTheDocument();

      // Expand it back
      const expandButton = screen.getByLabelText('Expand');
      fireEvent.click(expandButton);
      expect(screen.getByText('Dev1')).toBeInTheDocument();
    });

    it('should not show toggle for leaf nodes', () => {
      const members = [
        createTestMember({ id: 'root', name: 'Solo', parentMemberId: undefined }),
      ];
      render(<HierarchyTreeView members={members} />);

      expect(screen.queryByLabelText('Collapse')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Expand')).not.toBeInTheDocument();
    });
  });

  describe('Interactions', () => {
    it('should call onNodeClick when a node is clicked', () => {
      const members = createTestHierarchy();
      const handleClick = vi.fn();
      render(<HierarchyTreeView members={members} onNodeClick={handleClick} />);

      fireEvent.click(screen.getByText('Dev1'));
      expect(handleClick).toHaveBeenCalledTimes(1);
      expect(handleClick).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'dev-1', name: 'Dev1' })
      );
    });

    it('should not throw when onNodeClick is not provided', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      expect(() => fireEvent.click(screen.getByText('Dev1'))).not.toThrow();
    });
  });

  describe('Styling', () => {
    it('should apply custom className', () => {
      const members = createTestHierarchy();
      const { container } = render(
        <HierarchyTreeView members={members} className="my-custom-class" />
      );
      expect(container.firstChild).toHaveClass('my-custom-class');
    });

    it('should render data-testid for each node', () => {
      const members = createTestHierarchy();
      render(<HierarchyTreeView members={members} />);

      expect(screen.getByTestId('tree-node-orc')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-tl-1')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-dev-1')).toBeInTheDocument();
      expect(screen.getByTestId('tree-node-dev-2')).toBeInTheDocument();
    });
  });
});
