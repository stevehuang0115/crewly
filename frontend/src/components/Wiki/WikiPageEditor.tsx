/**
 * WikiPageEditor — owner-facing markdown editor for the per-team overlay
 * folders (team-norm/ and sop/). Used to author/edit team norms and custom
 * SOPs directly from the wiki, writing through to ~/.crewly/teams/<id>/{norms,sops}/.
 *
 * @module components/Wiki/WikiPageEditor
 */

import { useState, useCallback } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { FormGroup, FormHelp, FormInput, FormLabel, FormTextarea } from '@crewly/ui/Form';
import { Modal, ModalFooter } from '@crewly/ui/Modal';

/** Which overlay folder the editor targets. */
export type OverlayFolder = 'sop' | 'team-norm';

export interface WikiPageEditorProps {
  /** Absolute team vault path. */
  vaultPath: string;
  /** Target overlay folder. */
  folder: OverlayFolder;
  /** 'create' for a new page, 'edit' for an existing one. */
  mode: 'create' | 'edit';
  /** Existing page relativePath (edit mode), e.g. `team-norm/code-commit.md`. */
  initialPath?: string;
  /** Existing content (edit mode). */
  initialContent?: string;
  /** Close without saving. */
  onClose: () => void;
  /** Called after a successful save/delete with the affected relativePath (or null on delete). */
  onSaved: (relativePath: string | null) => void;
}

const LABELS: Record<OverlayFolder, string> = { sop: 'SOP', 'team-norm': 'Team Norm' };

/** Slugify a human title into a safe `.md` filename stem. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The overlay-page editor modal.
 *
 * @param props - See {@link WikiPageEditorProps}.
 * @returns The editor modal.
 */
export function WikiPageEditor({
  vaultPath,
  folder,
  mode,
  initialPath,
  initialContent,
  onClose,
  onSaved,
}: WikiPageEditorProps): JSX.Element {
  const [name, setName] = useState(() =>
    mode === 'edit' && initialPath ? initialPath.split('/').pop()!.replace(/\.md$/, '') : '',
  );
  const [content, setContent] = useState(initialContent ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = LABELS[folder];

  const save = useCallback(async () => {
    const stem = mode === 'edit' && initialPath ? initialPath.split('/').pop()!.replace(/\.md$/, '') : slugify(name);
    if (!stem) {
      setError('Please enter a name.');
      return;
    }
    const relativePath = mode === 'edit' && initialPath ? initialPath : `${folder}/${stem}.md`;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/wiki/overlay-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath, relativePath, content }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(relativePath);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [mode, initialPath, name, folder, vaultPath, content, onSaved]);

  const remove = useCallback(async () => {
    if (mode !== 'edit' || !initialPath) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/wiki/overlay-page', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath, relativePath: initialPath }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [mode, initialPath, vaultPath, onSaved]);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={mode === 'create' ? `New ${label}` : `Edit ${label}`}
      size="xxl"
      data-testid="wiki-page-editor"
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="error" size="sm">
            {error}
          </Alert>
        )}

        {mode === 'create' ? (
          <FormGroup>
            <FormLabel htmlFor="wiki-editor-name">Name</FormLabel>
            <FormInput
              id="wiki-editor-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={folder === 'sop' ? 'e.g. XHS posting checklist' : 'e.g. Code commit norm'}
              data-testid="wiki-editor-name"
              autoFocus
            />
            {name && <FormHelp className="font-mono">{folder}/{slugify(name)}.md</FormHelp>}
          </FormGroup>
        ) : (
          <FormGroup>
            <FormLabel>File</FormLabel>
            <code className="text-xs font-mono text-text-secondary-dark">{initialPath}</code>
          </FormGroup>
        )}

        <FormGroup>
          <FormLabel htmlFor="wiki-editor-content">Content (markdown)</FormLabel>
          <FormTextarea
            id="wiki-editor-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`# ${label}\n\nDescribe the ${label.toLowerCase()}…`}
            rows={16}
            className="font-mono text-xs"
            data-testid="wiki-editor-content"
            spellCheck={false}
          />
        </FormGroup>

        <ModalFooter align="space-between" className="px-0 pb-0">
          <div>
            {mode === 'edit' && (
              <Button
                type="button"
                variant="danger-ghost"
                icon={Trash2}
                onClick={remove}
                disabled={busy}
                data-testid="wiki-editor-delete"
              >
                Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              icon={Save}
              onClick={save}
              loading={busy}
              data-testid="wiki-editor-save"
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

export default WikiPageEditor;
