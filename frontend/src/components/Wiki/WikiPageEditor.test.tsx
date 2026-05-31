/**
 * Tests for WikiPageEditor — create/edit/delete of owner-authored overlay pages.
 *
 * @module components/Wiki/WikiPageEditor.test
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WikiPageEditor } from './WikiPageEditor';

describe('WikiPageEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const okFetch = () =>
    vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as Response);

  it('creates a norm: slugified path + content posted, then onSaved', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(
      <WikiPageEditor vaultPath="/v/wiki" folder="team-norm" mode="create" onClose={vi.fn()} onSaved={onSaved} />,
    );

    fireEvent.change(screen.getByTestId('wiki-editor-name'), { target: { value: 'Code Commit Norm' } });
    fireEvent.change(screen.getByTestId('wiki-editor-content'), { target: { value: 'rules here' } });
    fireEvent.click(screen.getByTestId('wiki-editor-save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('team-norm/code-commit-norm.md'));
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      vaultPath: '/v/wiki',
      relativePath: 'team-norm/code-commit-norm.md',
      content: 'rules here',
    });
  });

  it('creates a custom SOP under the sop/ folder', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(<WikiPageEditor vaultPath="/v/wiki" folder="sop" mode="create" onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('wiki-editor-name'), { target: { value: 'XHS Posting' } });
    fireEvent.click(screen.getByTestId('wiki-editor-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('sop/xhs-posting.md'));
  });

  it('edits an existing page (path fixed) and can delete it', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(
      <WikiPageEditor
        vaultPath="/v/wiki"
        folder="team-norm"
        mode="edit"
        initialPath="team-norm/existing.md"
        initialContent="old"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    // no name field in edit mode
    expect(screen.queryByTestId('wiki-editor-name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wiki-editor-delete'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null));
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('DELETE');
  });

  it('shows an error when save fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ success: false, error: 'not_writable' }) }) as Response),
    );
    render(<WikiPageEditor vaultPath="/v/wiki" folder="sop" mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('wiki-editor-name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('wiki-editor-save'));
    await waitFor(() => expect(screen.getByText('not_writable')).toBeInTheDocument());
  });
});
