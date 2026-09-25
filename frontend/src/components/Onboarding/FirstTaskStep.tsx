/**
 * FirstTaskStep
 *
 * First-run step "派第一件事": one text box and three example tasks from
 * the chosen starter. The task goes to the orchestrator through the owner's
 * chat path (`POST /api/onboarding/first-task`), addressed to the new team.
 *
 * @module components/Onboarding/FirstTaskStep
 */

import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { Alert, Button, FormTextarea } from '@crewly/ui';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';
import type { FirstTaskResult } from '../../types/onboarding-checklist.types';

/** Longest task the backend accepts. */
export const FIRST_TASK_MAX_LENGTH = 4000;

export interface FirstTaskStepProps {
  /** Example tasks (tap to fill the box) */
  suggestions: string[];
  /** Team the task is for (null = the orchestrator itself) */
  teamId: string | null;
  /** Team name, for the copy */
  teamName: string | null;
  /** Called once the orchestrator has the task */
  onSent: (result: FirstTaskResult) => void;
}

/**
 * First-task box.
 *
 * @param props - {@link FirstTaskStepProps}
 * @returns Step body
 */
export const FirstTaskStep: React.FC<FirstTaskStepProps> = ({ suggestions, teamId, teamName, onSent }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<FirstTaskResult | null>(null);

  const trimmed = text.trim();

  /** Send the task. */
  const send = async (): Promise<void> => {
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      const result = await onboardingChecklistService.sendFirstTask(trimmed, teamId);
      setSent(result);
      onSent(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Alert variant="success" title="已交给 Orc" data-testid="first-task-sent">
        {sent.message ? '等 Orc 上线就会开始处理。' : 'Orc 会安排团队去做，进展会在聊天和 Slack 里告诉你。'}
      </Alert>
    );
  }

  return (
    <div className="space-y-3" data-testid="first-task-step">
      <p className="text-sm text-text-secondary-dark">
        {teamName ? `交给「${teamName}」` : '交给 Orc'}，一句话说清楚就行。
      </p>
      <FormTextarea
        aria-label="第一件事"
        rows={4}
        maxLength={FIRST_TASK_MAX_LENGTH}
        placeholder="例如：每天早上 8 点给我一份简报"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary-dark">试试这些：</p>
          <div className="flex flex-col gap-2">
            {suggestions.map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant="outline"
                className="h-auto min-h-9 justify-start whitespace-normal py-2 text-left font-normal"
                onClick={() => setText(s)}
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      <Button type="button" fullWidth icon={Send} loading={sending} disabled={!trimmed} onClick={() => void send()} data-testid="first-task-send">
        派出去
      </Button>
    </div>
  );
};

export default FirstTaskStep;
