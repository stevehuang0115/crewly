/**
 * WikiPageEditor — owner-facing markdown editor for the per-team overlay
 * folders (team-norm/ and sop/). Used to author/edit team norms and custom
 * SOPs directly from the wiki, writing through to ~/.crewly/teams/<id>/{norms,sops}/.
 *
 * @module components/Wiki/WikiPageEditor
 */

import { useState, useCallback } from 'react';
import { X, Save, Trash2, AlertCircle } from 'lucide-react';
import './WikiPageEditor.css';

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
    <div className="wiki-editor-backdrop" onClick={onClose} role="presentation">
      <div
        className="wiki-editor-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${mode === 'create' ? 'New' : 'Edit'} ${label}`}
        data-testid="wiki-page-editor"
      >
        <div className="wiki-editor-header">
          <h2>
            {mode === 'create' ? `New ${label}` : `Edit ${label}`}
          </h2>
          <button type="button" className="wiki-editor-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="wiki-editor-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div className="wiki-editor-body">
          {mode === 'create' ? (
            <label className="wiki-editor-field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={folder === 'sop' ? 'e.g. XHS posting checklist' : 'e.g. Code commit norm'}
                data-testid="wiki-editor-name"
                autoFocus
              />
              {name && <span className="wiki-editor-filename">{folder}/{slugify(name)}.md</span>}
            </label>
          ) : (
            <div className="wiki-editor-field">
              <span>File</span>
              <code className="wiki-editor-filename">{initialPath}</code>
            </div>
          )}

          <label className="wiki-editor-field grow">
            <span>Content (markdown)</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={`# ${label}\n\nDescribe the ${label.toLowerCase()}…`}
              data-testid="wiki-editor-content"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="wiki-editor-footer">
          {mode === 'edit' && (
            <button
              type="button"
              className="wiki-editor-delete"
              onClick={remove}
              disabled={busy}
              data-testid="wiki-editor-delete"
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
          <div className="wiki-editor-footer-right">
            <button type="button" className="wiki-editor-cancel" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="wiki-editor-save"
              onClick={save}
              disabled={busy}
              data-testid="wiki-editor-save"
            >
              <Save size={14} /> {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WikiPageEditor;
