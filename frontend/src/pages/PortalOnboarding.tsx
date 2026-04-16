/**
 * PortalOnboarding Page
 *
 * The Magic Moment onboarding flow for KR3 (sub-5-minute onboarding).
 * Three-step flow: URL input → AI prefill preview → Confirm and create.
 *
 * Entry conditions:
 * - Stripe success redirect: /portal/onboarding?teamId=XYZ&status=success
 * - Manual portal entry after auth: /portal/onboarding
 * - Resume incomplete session: /portal/onboarding?sessionId=...
 *
 * @module pages/PortalOnboarding
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  OnboardingStep,
  OnboardingPrefill,
  OnboardingSummary,
  OnboardingSessionResponse,
  PrefillField,
} from '../types/onboarding.types';
import { REVIEW_CARDS } from '../types/onboarding.types';
import { ProgressRail } from '../components/PortalOnboarding/ProgressRail';
import { UrlInputStep } from '../components/PortalOnboarding/UrlInputStep';
import { AnalysisProgress } from '../components/PortalOnboarding/AnalysisProgress';
import { ReviewStep } from '../components/PortalOnboarding/ReviewStep';
import { ConfirmStep } from '../components/PortalOnboarding/ConfirmStep';
import { apiService } from '../services/api.service';

/** Polling interval for session status during analysis (ms) */
const SESSION_POLL_INTERVAL = 3000;

/** Max polling time before timeout (ms) */
const MAX_ANALYSIS_DURATION = 120000;

/**
 * PortalOnboarding page component.
 *
 * Orchestrates the 3-step onboarding flow, manages session state,
 * and communicates with the backend onboarding API.
 *
 * @returns The PortalOnboarding page element
 */
export const PortalOnboarding: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [step, setStep] = useState<OnboardingStep>('url-input');
  const [sessionId, setSessionId] = useState<string | null>(
    searchParams.get('sessionId')
  );
  const [websiteUrl, setWebsiteUrl] = useState('');

  // Analysis state
  const [analysisFailed, setAnalysisFailed] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | undefined>();

  // Review state
  const [summary, setSummary] = useState<OnboardingSummary | null>(null);
  const [prefill, setPrefill] = useState<OnboardingPrefill>({});
  const [originalPrefill, setOriginalPrefill] = useState<OnboardingPrefill>({});
  const [editedFields, setEditedFields] = useState<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Resume existing session on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const existingSessionId = searchParams.get('sessionId');
    if (existingSessionId) {
      resumeSession(existingSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Resumes an existing onboarding session.
   *
   * @param id - Session ID to resume
   */
  const resumeSession = async (id: string) => {
    try {
      const session = (await apiService.getOnboardingSession(id)) as unknown as OnboardingSessionResponse;
      setSessionId(id);
      setWebsiteUrl(session.websiteUrl || '');

      if (session.status === 'draft_ready' && session.prefill) {
        setSummary(session.summary ?? null);
        setPrefill(session.prefill);
        setOriginalPrefill(session.prefill);
        setStep('review');
      } else if (session.status === 'analyzing') {
        setStep('analyzing');
        pollSession(id);
      } else if (session.status === 'completed') {
        // Already completed — redirect to dashboard
        navigate('/');
      }
    } catch {
      // Session not found — start fresh
      setStep('url-input');
    }
  };

  // ---------------------------------------------------------------------------
  // Step 1: URL submission
  // ---------------------------------------------------------------------------

  /**
   * Handles URL submission — creates a session and starts analysis.
   *
   * @param url - The normalized website URL
   */
  const handleUrlSubmit = useCallback(async (url: string) => {
    setWebsiteUrl(url);
    setAnalysisFailed(false);
    setAnalysisError(undefined);
    setStep('analyzing');

    try {
      const teamId = searchParams.get('teamId') || undefined;
      const result = await apiService.createOnboardingSession({
        websiteUrl: url,
        teamId,
      });
      setSessionId(result.sessionId);
      pollSession(result.sessionId);
    } catch (err) {
      setAnalysisFailed(true);
      setAnalysisError(
        err instanceof Error ? err.message : 'Failed to start analysis'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ---------------------------------------------------------------------------
  // Session polling
  // ---------------------------------------------------------------------------

  /**
   * Polls the session status until analysis completes or fails.
   *
   * @param id - Session ID to poll
   */
  const pollSession = (id: string) => {
    const startTime = Date.now();

    const poll = async () => {
      if (Date.now() - startTime > MAX_ANALYSIS_DURATION) {
        setAnalysisFailed(true);
        setAnalysisError('Analysis timed out. The site may be too complex.');
        return;
      }

      try {
        const session = (await apiService.getOnboardingSession(id)) as unknown as OnboardingSessionResponse;

        if (session.status === 'draft_ready' && session.prefill) {
          setSummary(session.summary ?? null);
          setPrefill(session.prefill);
          setOriginalPrefill(session.prefill);
          setStep('review');
          return;
        }

        if (session.status === 'failed') {
          setAnalysisFailed(true);
          setAnalysisError(session.error || 'Analysis failed');
          // Check for partial data
          if (session.prefill && Object.keys(session.prefill).length > 0) {
            setPrefill(session.prefill);
            setOriginalPrefill(session.prefill);
            setSummary(session.summary ?? null);
          }
          return;
        }

        // Continue polling
        setTimeout(poll, SESSION_POLL_INTERVAL);
      } catch {
        setAnalysisFailed(true);
        setAnalysisError('Lost connection while checking analysis status');
      }
    };

    poll();
  };

  // ---------------------------------------------------------------------------
  // Step 2: Review — field editing
  // ---------------------------------------------------------------------------

  /**
   * Handles editing an AI-extracted field.
   *
   * @param key - The field key in OnboardingPrefill
   * @param value - New value
   */
  const handleFieldEdit = useCallback(
    (key: keyof OnboardingPrefill, value: string | string[]) => {
      setPrefill((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] as PrefillField),
          value,
          confidence: 'high', // Manual edit = user confirmed
          extractionMethod: 'manual',
          needsReview: false,
        },
      }));
      setEditedFields((prev) => new Set(prev).add(key));
    },
    []
  );

  /**
   * Resets a field to its original AI-drafted value.
   *
   * @param key - The field key to reset
   */
  const handleFieldReset = useCallback(
    (key: keyof OnboardingPrefill) => {
      setPrefill((prev) => ({
        ...prev,
        [key]: originalPrefill[key],
      }));
      setEditedFields((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [originalPrefill]
  );

  /**
   * Checks if any required low-confidence fields remain unresolved.
   * These block confirmation.
   */
  const hasBlockingFields = useMemo(() => {
    for (const card of REVIEW_CARDS) {
      for (const fieldConfig of card.fields) {
        if (!fieldConfig.required) continue;
        const field = prefill[fieldConfig.key] as PrefillField | undefined;
        if (!field) return true; // Missing required field
        if (field.confidence === 'low' && field.needsReview) return true;
      }
    }
    return false;
  }, [prefill]);

  // ---------------------------------------------------------------------------
  // Step 3: Confirm and create
  // ---------------------------------------------------------------------------

  /**
   * Completes the onboarding — approves profile and creates workspace.
   */
  const handleConfirm = useCallback(async () => {
    if (!sessionId) throw new Error('No session to complete');

    // Build approved profile from prefill
    const profile: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(prefill)) {
      if (field && typeof field === 'object' && 'value' in field) {
        profile[key] = (field as PrefillField).value;
      }
    }

    await apiService.approveOnboardingProfile(sessionId, profile);
    await apiService.completeOnboarding(sessionId);

    // Navigate to dashboard after short delay for success animation
    setTimeout(() => navigate('/'), 2000);
  }, [sessionId, prefill, navigate]);

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  const handleRetry = useCallback(() => {
    setStep('url-input');
    setAnalysisFailed(false);
    setAnalysisError(undefined);
    setWebsiteUrl('');
  }, []);

  const handleReviewPartial = useCallback(() => {
    setStep('review');
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-[calc(100vh-64px)] flex flex-col">
      {/* Progress rail */}
      <div className="border-b border-border-dark bg-surface-dark/50 px-4 py-3">
        <ProgressRail currentStep={step} className="max-w-[960px] mx-auto" />
      </div>

      {/* Main content */}
      <div className="flex-1 px-4 md:px-6 py-8">
        {step === 'url-input' && (
          <UrlInputStep
            onSubmit={handleUrlSubmit}
            onManualSetup={() => navigate('/marketplace')}
          />
        )}

        {step === 'analyzing' && (
          <AnalysisProgress
            hasFailed={analysisFailed}
            errorMessage={analysisError}
            hasPartialData={Object.keys(prefill).length > 0}
            onReviewPartial={handleReviewPartial}
            onRetry={handleRetry}
          />
        )}

        {step === 'review' && (
          <ReviewStep
            websiteUrl={websiteUrl}
            summary={summary}
            prefill={prefill}
            editedFields={editedFields}
            onFieldEdit={handleFieldEdit}
            onFieldReset={handleFieldReset}
            onConfirm={() => setStep('confirm')}
            hasBlockingFields={hasBlockingFields}
          />
        )}

        {step === 'confirm' && (
          <ConfirmStep
            prefill={prefill}
            onConfirm={handleConfirm}
            onBack={() => setStep('review')}
            hasBlockingFields={hasBlockingFields}
          />
        )}
      </div>
    </div>
  );
};

export default PortalOnboarding;
