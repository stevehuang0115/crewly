/**
 * BundleQuestionsForm
 *
 * The deploy-time questions of a solution bundle (business name, what you
 * sell, customers, platforms, tone…). Their answers fill the bundle's
 * prompts, norms and schedules. Text, textarea, select and multiselect
 * (tappable chips — phone first). Required questions are checked here and
 * again by the backend, whose `missing` list is shown on the fields.
 *
 * @module components/Onboarding/BundleQuestionsForm
 */

import React, { useState } from 'react';
import { Alert, Button, FormGroup, FormHelp, FormInput, FormLabel, FormSelect, FormTextarea } from '@crewly/ui';
import {
  initialAnswers,
  missingRequiredAnswers,
  type BundleAnswers,
  type BundleQuestion,
} from '../../types/bundle.types';

export interface BundleQuestionsFormProps {
  questions: BundleQuestion[];
  /** Deploy button text */
  submitLabel: string;
  /** True while the deploy request is in flight */
  submitting?: boolean;
  /** Server error to show above the button */
  error?: string | null;
  /** Question ids the server reported as unanswered or invalid */
  serverProblems?: string[];
  onSubmit: (answers: BundleAnswers) => void;
}

/**
 * Deploy-time questions form.
 *
 * @param props - {@link BundleQuestionsFormProps}
 * @returns Form
 */
export const BundleQuestionsForm: React.FC<BundleQuestionsFormProps> = ({
  questions,
  submitLabel,
  submitting = false,
  error = null,
  serverProblems = [],
  onSubmit,
}) => {
  const [answers, setAnswers] = useState<BundleAnswers>(() => initialAnswers(questions));
  const [missing, setMissing] = useState<string[]>([]);

  const flagged = new Set([...missing, ...serverProblems]);

  /** Update one answer (and clear its "missing" mark). */
  const set = (id: string, value: string | string[]): void => {
    setAnswers((cur) => ({ ...cur, [id]: value }));
    setMissing((cur) => cur.filter((m) => m !== id));
  };

  /** Toggle one multiselect option. */
  const toggle = (id: string, value: string): void => {
    const cur = answers[id];
    const list = Array.isArray(cur) ? cur : [];
    set(id, list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  /** Validate required answers, then submit. */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const unanswered = missingRequiredAnswers(questions, answers);
    setMissing(unanswered);
    if (unanswered.length === 0) onSubmit(answers);
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate data-testid="bundle-questions">
      {questions.map((q) => {
        const inputId = `bundle-q-${q.id}`;
        const value = answers[q.id];
        const bad = flagged.has(q.id);
        return (
          <FormGroup key={q.id}>
            <FormLabel id={`${inputId}-label`} htmlFor={q.type === 'multiselect' ? undefined : inputId} required={q.required}>
              {q.label}
            </FormLabel>
            {q.type === 'text' && (
              <FormInput
                id={inputId}
                value={typeof value === 'string' ? value : ''}
                placeholder={q.placeholder}
                error={bad}
                onChange={(e) => set(q.id, e.target.value)}
              />
            )}
            {q.type === 'textarea' && (
              <FormTextarea
                id={inputId}
                rows={3}
                value={typeof value === 'string' ? value : ''}
                placeholder={q.placeholder}
                error={bad}
                onChange={(e) => set(q.id, e.target.value)}
              />
            )}
            {q.type === 'select' && (
              <FormSelect id={inputId} value={typeof value === 'string' ? value : ''} error={bad} onChange={(e) => set(q.id, e.target.value)}>
                {!q.required && q.default === '' && <option value="">—</option>}
                {q.required && <option value="">请选择</option>}
                {(q.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label ?? o.value}
                  </option>
                ))}
              </FormSelect>
            )}
            {q.type === 'multiselect' && (
              <div role="group" aria-labelledby={`${inputId}-label`} className="flex flex-wrap gap-2" id={inputId}>
                {(q.options ?? []).map((o) => {
                  const on = Array.isArray(value) && value.includes(o.value);
                  return (
                    <Button
                      key={o.value}
                      type="button"
                      size="sm"
                      variant={on ? 'primary' : 'secondary'}
                      aria-pressed={on}
                      data-testid={`bundle-option-${q.id}-${o.value}`}
                      onClick={() => toggle(q.id, o.value)}
                    >
                      {o.label ?? o.value}
                    </Button>
                  );
                })}
              </div>
            )}
            {q.help && <FormHelp>{q.help}</FormHelp>}
            {bad && (
              <p className="mt-1 text-xs text-red-400" role="alert" data-testid={`bundle-missing-${q.id}`}>
                {q.type === 'multiselect' ? '请至少选一个' : '这一项必填'}
              </p>
            )}
          </FormGroup>
        );
      })}
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      <Button type="submit" fullWidth loading={submitting} data-testid="bundle-deploy">
        {submitLabel}
      </Button>
    </form>
  );
};

export default BundleQuestionsForm;
