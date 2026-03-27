/**
 * Auth Page
 *
 * Login / register page that redirects users to CrewlyAI Cloud (Supabase)
 * for OAuth authentication. Supports Google sign-in and email-based magic
 * link flow. If the user is already authenticated, redirects to the Cloud
 * settings tab.
 *
 * @module pages/Auth
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Cloud } from 'lucide-react';
import { Button } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { buildCloudAuthRedirectUrl } from '../constants/cloud.constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Benefits displayed below the auth card */
const BENEFITS: string[] = [
  'Unlimited teams & agents',
  'Cloud Relay for cross-machine control',
  'Premium marketplace templates',
  'Priority support',
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Auth page component.
 *
 * Renders a centered card with Google and email sign-in options.
 * Redirects authenticated users to the Cloud settings page.
 *
 * @returns The auth page element
 */
export const Auth: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');

  // Redirect authenticated users to Cloud settings
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/settings?tab=cloud', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  /**
   * Handle Google sign-in button click.
   * Redirects the browser to the Cloud OAuth page.
   */
  const handleGoogleSignIn = () => {
    window.location.href = buildCloudAuthRedirectUrl();
  };

  /**
   * Handle email sign-in form submission.
   * Redirects the browser to the Cloud auth page with the email parameter.
   *
   * @param e - Form submit event
   */
  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    const baseUrl = buildCloudAuthRedirectUrl();
    window.location.href = `${baseUrl}&email=${encodeURIComponent(email.trim())}`;
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background-dark px-4 py-12">
      {/* Auth card */}
      <div className="w-full max-w-md rounded-xl border border-border-dark bg-surface-dark p-8">
        {/* Header */}
        <div className="mb-6 text-center">
          <Cloud className="mx-auto h-10 w-10 text-primary" />
          <h1 className="mt-3 text-2xl font-bold text-text-primary-dark">
            Crewly Cloud
          </h1>
          <p className="mt-2 text-text-secondary-dark">
            Sign in to unlock premium features
          </p>
        </div>

        {/* Google sign in */}
        <Button
          variant="outline"
          className="w-full"
          onClick={handleGoogleSignIn}
          data-testid="google-signin-btn"
        >
          Sign in with Google
        </Button>

        {/* Divider */}
        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-border-dark" />
          <span className="text-xs text-text-secondary-dark">or</span>
          <div className="h-px flex-1 bg-border-dark" />
        </div>

        {/* Email form */}
        <form onSubmit={handleEmailSubmit}>
          <label htmlFor="auth-email" className="mb-1 block text-sm font-medium text-text-secondary-dark">
            Email
          </label>
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mb-4 w-full rounded-lg border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark placeholder-text-secondary-dark focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            data-testid="email-input"
          />
          <Button
            variant="primary"
            className="w-full"
            type="submit"
            data-testid="email-signin-btn"
          >
            Continue with Email
          </Button>
        </form>

        {/* Terms */}
        <p className="mt-4 text-center text-xs text-text-secondary-dark">
          By continuing, you agree to our{' '}
          <a
            href="https://crewlyai.com/terms"
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Terms of Service
          </a>
        </p>
      </div>

      {/* Benefits */}
      <div className="mt-8 w-full max-w-md" data-testid="benefits-list">
        <h2 className="mb-3 text-sm font-semibold text-text-secondary-dark">
          Benefits
        </h2>
        <ul className="space-y-2">
          {BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-center gap-2 text-sm text-text-secondary-dark">
              <Check className="h-4 w-4 flex-shrink-0 text-emerald-400" />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default Auth;
