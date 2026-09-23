/**
 * ProjectCreator tests — path entry dialog for creating a project.
 *
 * @module components/Modals/ProjectCreator.test
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectCreator } from './ProjectCreator';

vi.mock('./FolderBrowser', () => ({
  FolderBrowser: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="folder-browser">
      <button onClick={onClose}>close browser</button>
    </div>
  ),
}));

describe('ProjectCreator', () => {
  it('disables Create until a path is entered', () => {
    render(<ProjectCreator onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Create Project' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Project Path/), { target: { value: '/tmp/x' } });
    expect(screen.getByRole('button', { name: 'Create Project' })).toBeEnabled();
  });

  it('saves the trimmed path', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectCreator onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project Path/), { target: { value: '  /work/app  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('/work/app'));
  });

  it('shows the save error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Path does not exist'));
    render(<ProjectCreator onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Project Path/), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
    expect(await screen.findByText('Path does not exist')).toBeInTheDocument();
  });

  it('opens the folder browser from Browse', () => {
    render(<ProjectCreator onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    expect(screen.getByTestId('folder-browser')).toBeInTheDocument();
  });

  it('closes from Cancel', () => {
    const onClose = vi.fn();
    render(<ProjectCreator onSave={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
