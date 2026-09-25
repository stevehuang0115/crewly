/**
 * BrokerLoginPanel
 *
 * UI for one login-broker method (Claude subscription or Codex device
 * code). The backend runs the harness's own login command in a hidden
 * terminal and extracts the URL / one-time code / prompts from the screen;
 * this panel shows them and sends back what the user types.
 *
 * - URL → big "打开授权页面" button (new tab)
 * - userCode → large code + copy, "完成后这里会自动继续"
 * - needsInput → "把页面上给你的代码粘贴到这里" + 提交
 * - awaiting_user with none of the above → collapsible raw "终端内容" + free-text box
 * - failed / timed_out → message + 重试
 *
 * @module components/Harness/BrokerLoginPanel
 */

import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, LogIn, RotateCcw } from 'lucide-react';
import { Alert, Button, Input, LoadingSpinner } from '@crewly/ui';
import type { BrokerLoginMethodId, HarnessId, LoginSession } from '../../types/harness.types';
import { isTerminalLoginState, isUnrecognizedScreen } from '../../types/harness.types';
import { LOGIN_SESSION_STATE_LABELS } from '../../constants/harness.constants';
import { useLoginSession } from '../../hooks/useLoginSession';
import { harnessService } from '../../services/harness.service';
import { isSafeHttpUrl } from '../../utils/safe-url';
import { CopyButton } from './CopyButton';

export interface BrokerLoginPanelProps {
  /** Harness to log in to */
  harnessId: HarnessId;
  /** Broker method */
  method: BrokerLoginMethodId;
  /** Label of the start button (e.g. "用 Claude 订阅登录") */
  label: string;
  /** Called once when the login succeeds */
  onSucceeded?: () => void;
}

interface TextSubmitFormProps {
  /** Field label */
  label: string;
  /** Submit button text */
  submitLabel: string;
  /** Disable while sending */
  busy: boolean;
  /** Send handler; resolves true when accepted (field is then cleared) */
  onSubmit: (text: string) => Promise<boolean>;
  /** Monospace input (raw terminal text) */
  mono?: boolean;
  /** Test id */
  testId: string;
}

/**
 * Single-line text form used for the pasted code and for raw terminal input.
 *
 * @param props - {@link TextSubmitFormProps}
 * @returns Form element
 */
const TextSubmitForm: React.FC<TextSubmitFormProps> = ({ label, submitLabel, busy, onSubmit, mono, testId }) => {
  const [text, setText] = useState('');

  /**
   * Send the text and clear the field on success.
   *
   * @param e - Submit event
   */
  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (await onSubmit(value)) setText('');
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end" data-testid={testId}>
      <div className="flex-1 min-w-0">
        <Input
          label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={mono ? 'font-mono' : undefined}
          fullWidth
        />
      </div>
      <Button type="submit" loading={busy} disabled={!text.trim() || busy} className="shrink-0">
        {submitLabel}
      </Button>
    </form>
  );
};

/**
 * Open a scraped URL in a new tab when it is a safe http(s) link.
 *
 * @param url - URL from the broker
 */
function openInNewTab(url: string): void {
  if (isSafeHttpUrl(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

interface AwaitingUserProps {
  session: LoginSession;
  busy: boolean;
  sendInput: (text: string) => Promise<boolean>;
}

/**
 * The `awaiting_user` body: link, code, paste field or raw-screen fallback.
 *
 * @param props - {@link AwaitingUserProps}
 * @returns Section element
 */
const AwaitingUser: React.FC<AwaitingUserProps> = ({ session, busy, sendInput }) => {
  const url = isSafeHttpUrl(session.url) ? session.url : null;

  if (isUnrecognizedScreen(session)) {
    return (
      <div className="space-y-3" data-testid="login-fallback">
        <p className="text-sm text-text-secondary-dark">
          没能自动识别登录画面，请根据下面的终端内容操作。We couldn't read the login screen automatically.
        </p>
        <details className="rounded-2xl border border-border-dark bg-background-dark" open>
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-text-primary-dark">终端内容</summary>
          <pre
            className="max-h-64 overflow-auto border-t border-border-dark p-3 font-mono text-xs text-text-secondary-dark whitespace-pre-wrap break-all"
            data-testid="login-screen"
          >
            {session.screen || '（空）'}
          </pre>
        </details>
        <TextSubmitForm
          label="发送到终端 / Send to terminal"
          submitLabel="发送"
          busy={busy}
          onSubmit={sendInput}
          mono
          testId="login-raw-input"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {url && (
        <div className="space-y-2">
          <Button type="button" fullWidth icon={ExternalLink} onClick={() => openInNewTab(url)} data-testid="login-open-url">
            打开授权页面
          </Button>
          <p className="text-xs text-text-secondary-dark break-all">{url}</p>
        </div>
      )}

      {session.userCode && (
        <div className="rounded-2xl border border-border-dark bg-background-dark p-4 text-center space-y-3" data-testid="login-user-code">
          <p className="text-xs text-text-secondary-dark">验证码 / One-time code</p>
          <p className="font-mono text-3xl font-bold tracking-widest text-text-primary-dark select-all break-all">
            {session.userCode}
          </p>
          <CopyButton value={session.userCode} label="复制验证码" />
          <p className="text-sm text-text-secondary-dark">在打开的页面输入这个验证码，完成后这里会自动继续</p>
        </div>
      )}

      {session.needsInput && (
        <TextSubmitForm
          label="把页面上给你的代码粘贴到这里"
          submitLabel="提交 / Submit"
          busy={busy}
          onSubmit={sendInput}
          testId="login-code-input"
        />
      )}
    </div>
  );
};

/**
 * Login-broker panel for one method.
 *
 * @param props - {@link BrokerLoginPanelProps}
 * @returns Panel element
 */
export const BrokerLoginPanel: React.FC<BrokerLoginPanelProps> = ({ harnessId, method, label, onSucceeded }) => {
  const { session, error, busy, start, sendInput, cancel } = useLoginSession(harnessId, onSucceeded);

  // Cancel a live session when the panel goes away (method switch, leaving
  // the page) so the hidden login terminal doesn't linger.
  const liveRef = useRef<LoginSession | null>(null);
  liveRef.current = session && !isTerminalLoginState(session.state) ? session : null;
  useEffect(
    () => () => {
      if (liveRef.current) void harnessService.cancelLogin(liveRef.current.id).catch(() => undefined);
    },
    [],
  );

  if (!session) {
    return (
      <div className="space-y-3">
        <Button type="button" fullWidth icon={LogIn} loading={busy} onClick={() => void start(method)} data-testid="login-start">
          {label}
        </Button>
        {error && (
          <Alert variant="error" size="sm">
            {error}
          </Alert>
        )}
      </div>
    );
  }

  const failed = session.state === 'failed' || session.state === 'timed_out';
  const live = !isTerminalLoginState(session.state);

  return (
    <div className="space-y-4" data-testid="login-session" data-state={session.state}>
      {(session.state === 'starting' || session.state === 'verifying') && (
        <LoadingSpinner size="sm" inline text={LOGIN_SESSION_STATE_LABELS[session.state]} />
      )}

      {session.state === 'awaiting_user' && <AwaitingUser session={session} busy={busy} sendInput={sendInput} />}

      {session.state === 'awaiting_user' && session.message && (
        <p className="text-sm text-text-secondary-dark">{session.message}</p>
      )}

      {session.state === 'succeeded' && (
        <Alert variant="success" size="sm" title="登录成功 / Signed in">
          {session.message || '现在可以使用了。'}
        </Alert>
      )}

      {failed && (
        <Alert variant="error" size="sm" title={LOGIN_SESSION_STATE_LABELS[session.state]}>
          {session.message || '请重试。Please try again.'}
        </Alert>
      )}

      {session.state === 'cancelled' && (
        <p className="text-sm text-text-secondary-dark">{LOGIN_SESSION_STATE_LABELS.cancelled}</p>
      )}

      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        {(failed || session.state === 'cancelled') && (
          <Button type="button" icon={RotateCcw} loading={busy} onClick={() => void start(method)}>
            重试 / Retry
          </Button>
        )}
        {live && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
            取消 / Cancel
          </Button>
        )}
      </div>
    </div>
  );
};
