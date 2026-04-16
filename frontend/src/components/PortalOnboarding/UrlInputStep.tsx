/**
 * UrlInputStep Component
 *
 * Step 1 of the onboarding flow: URL input with validation.
 * Accepts a full URL or bare domain, auto-normalizes protocol,
 * and provides inline validation before submission.
 *
 * @module components/PortalOnboarding/UrlInputStep
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Globe, ArrowRight, Shield, Edit3, Clock } from 'lucide-react';
import { Button } from '../UI';

export interface UrlInputStepProps {
  /** Called when the user submits a valid URL */
  onSubmit: (url: string) => void;
  /** Whether submission is in progress */
  isSubmitting?: boolean;
  /** Called when user chooses manual setup */
  onManualSetup?: () => void;
}

/** URL validation regex (simple but practical) */
const URL_REGEX = /^(https?:\/\/)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/.*)?$/;

/**
 * Normalizes a URL by adding https:// if missing.
 *
 * @param input - Raw user input
 * @returns Normalized URL string
 */
const normalizeUrl = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

/**
 * Renders the URL input step with validation and trust signals.
 *
 * @param props - Step configuration
 * @returns UrlInputStep element
 */
export const UrlInputStep: React.FC<UrlInputStepProps> = ({
  onSubmit,
  isSubmitting = false,
  onManualSetup,
}) => {
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);

  const isValid = useMemo(() => URL_REGEX.test(normalizeUrl(url)), [url]);
  const isEmpty = url.trim().length === 0;

  const errorMessage = useMemo(() => {
    if (!touched || isEmpty) return null;
    if (!isValid) return 'Enter a valid website URL';
    return null;
  }, [touched, isEmpty, isValid]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setTouched(true);
      if (isValid && !isSubmitting) {
        onSubmit(normalizeUrl(url));
      }
    },
    [url, isValid, isSubmitting, onSubmit]
  );

  return (
    <div className="mx-auto max-w-[720px] w-full" data-testid="url-input-step">
      {/* Hero */}
      <div className="text-center mb-8">
        <h1 className="text-2xl md:text-3xl font-bold text-text-primary-dark mb-3">
          Build your first Crewly workspace from your website
        </h1>
        <p className="text-text-secondary-dark text-sm md:text-base max-w-lg mx-auto">
          Paste your URL and we&apos;ll draft your brand profile, recommended team,
          and first workflow.
        </p>
      </div>

      {/* URL Input Card */}
      <div className="rounded-xl border border-border-dark bg-surface-dark p-6 md:p-8">
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Input */}
          <div>
            <label
              htmlFor="website-url"
              className="block text-sm font-medium text-text-primary-dark mb-2"
            >
              Company website
            </label>
            <div className="relative">
              <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-text-secondary-dark" />
              <input
                id="website-url"
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (!touched) setTouched(true);
                }}
                onBlur={() => setTouched(true)}
                placeholder="e.g. acme.com or https://acme.com"
                className={`w-full h-14 pl-10 pr-4 rounded-xl border text-base text-text-primary-dark bg-background-dark placeholder:text-text-secondary-dark/50 focus:outline-none focus:ring-2 transition-colors ${
                  errorMessage
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-border-dark focus:ring-primary focus:border-primary'
                }`}
                autoFocus
                autoComplete="url"
                data-testid="url-input"
                aria-invalid={errorMessage ? 'true' : undefined}
                aria-describedby={errorMessage ? 'url-error' : 'url-helper'}
              />
            </div>
            {errorMessage ? (
              <p
                id="url-error"
                className="mt-2 text-sm text-red-400"
                role="alert"
              >
                {errorMessage}
              </p>
            ) : (
              <p
                id="url-helper"
                className="mt-2 text-xs text-text-secondary-dark"
              >
                {isEmpty
                  ? 'Enter your company website to continue'
                  : isValid
                  ? 'Looks good!'
                  : ''}
              </p>
            )}
          </div>

          {/* CTA */}
          <Button
            type="submit"
            variant="primary"
            fullWidth
            disabled={!isValid || isSubmitting}
            loading={isSubmitting}
            icon={ArrowRight}
            iconPosition="right"
            className="h-12 text-base"
            data-testid="generate-preview-btn"
          >
            Generate my preview
          </Button>
        </form>

        {/* Trust signals */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-xs text-text-secondary-dark">
          <span className="flex items-center gap-1">
            <Shield className="h-3 w-3" /> Same-domain crawl only
          </span>
          <span className="flex items-center gap-1">
            <Edit3 className="h-3 w-3" /> Editable before save
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> Usually done in 20–30 sec
          </span>
        </div>

        {/* Microcopy */}
        <p className="mt-3 text-center text-xs text-text-secondary-dark/70">
          We only analyze public pages on your domain by default. Nothing is
          published or connected until you confirm.
        </p>
      </div>

      {/* Manual setup link */}
      {onManualSetup && (
        <div className="mt-4 text-center">
          <button
            onClick={onManualSetup}
            className="text-sm text-text-secondary-dark hover:text-primary underline-offset-2 hover:underline transition-colors"
            data-testid="manual-setup-link"
          >
            I&apos;d rather set this up manually
          </button>
        </div>
      )}
    </div>
  );
};

UrlInputStep.displayName = 'UrlInputStep';
