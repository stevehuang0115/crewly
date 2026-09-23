/**
 * AgentDetailModal tests — view/edit an agent's runtime, model and skills.
 *
 * @module components/TeamDetail/AgentDetailModal.test
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentDetailModal } from './AgentDetailModal';
import { rolesService } from '../../services/roles.service';
import type { TeamMember } from '../../types';
import type { RoleWithPrompt } from '../../types/role.types';

vi.mock('../../services/roles.service', () => ({
  rolesService: { getRole: vi.fn() },
}));
vi.mock('../../hooks/useSkills', () => ({
  useSkills: () => ({ skills: [{ id: 'code-review', name: 'Code Review' }] }),
}));
vi.mock('../TeamBuilder/ExpertSelector', () => ({
  ExpertSelector: () => <div data-testid="expert-selector" />,
}));

const member: TeamMember = {
  id: 'm1',
  name: 'Ava',
  sessionName: 'ava',
  role: 'developer',
  systemPrompt: '',
  agentStatus: 'inactive',
  workingStatus: 'idle',
  runtimeType: 'codex-cli',
  createdAt: '',
  updatedAt: '',
};

const developerRole: RoleWithPrompt = {
  id: 'developer',
  name: 'developer',
  displayName: 'Developer',
  description: 'Writes code',
  category: 'development',
  systemPromptFile: 'developer-prompt.md',
  systemPromptContent: '',
  assignedSkills: ['code-review'],
  isDefault: false,
  isHidden: false,
  isBuiltin: true,
  createdAt: '',
  updatedAt: '',
};

describe('AgentDetailModal', () => {
  beforeEach(() => {
    vi.mocked(rolesService.getRole).mockResolvedValue(developerRole);
  });

  it('shows role details and resolved skill names', async () => {
    render(<AgentDetailModal member={member} onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Ava' })).toBeInTheDocument();
    expect(await screen.findByText('Developer')).toBeInTheDocument();
    expect(await screen.findByText('Code Review')).toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
  });

  it('closes from the Close button in read-only mode', () => {
    const onClose = vi.fn();
    render(<AgentDetailModal member={member} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('saves edited runtime and model in edit mode', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<AgentDetailModal member={member} onClose={onClose} isEditable onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'claude-code' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: ' opus ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('m1', expect.objectContaining({ runtimeType: 'claude-code', modelId: 'opus' })),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
