/**
 * Cloud Portal Page
 *
 * Post-payment landing page for Crewly Pro subscribers. Shows subscription
 * status, deployed teams, and a "Deploy Team" wizard that triggers
 * DigitalOcean provisioning via the provisioning API.
 *
 * Flow: Payment success → Cloud Portal → Deploy Team → Chat with team
 *
 * @module pages/CloudPortal
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Cloud,
  Rocket,
  CheckCircle2,
  AlertCircle,
  Loader2,
  MessageSquare,
  Server,
  Globe,
} from 'lucide-react';
import { Button } from '../components/UI';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Deployment status phases */
type DeployPhase =
  | 'idle'
  | 'configuring'
  | 'deploying'
  | 'ready'
  | 'error';

/** A single deployment record */
interface Deployment {
  deploymentId: string;
  currentPhase: string;
  success: boolean;
  ipAddress?: string;
  dropletId?: number;
  error?: string;
}

/** Subscription info from the payment API */
interface SubscriptionInfo {
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default region for new deployments */
const DEFAULT_REGION = 'sfo3';

/** Default droplet size */
const DEFAULT_SIZE = 's-2vcpu-4gb';

/** Polling interval for deployment status (ms) */
const STATUS_POLL_INTERVAL = 5000;

/** Max polling duration before timeout (ms) */
const MAX_POLL_DURATION = 600000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Cloud Portal page component.
 *
 * Shows the user's subscription status and allows them to deploy
 * a Crewly team to a DigitalOcean droplet with one click.
 *
 * @returns The Cloud Portal page element
 */
export const CloudPortal: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { license, user } = useAuth();
  const justUpgraded = searchParams.get('upgraded') === 'true';

  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(true);

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(true);

  const [deployPhase, setDeployPhase] = useState<DeployPhase>('idle');
  const [teamName, setTeamName] = useState('');
  const [deployError, setDeployError] = useState<string | null>(null);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Load subscription and deployments
  // -----------------------------------------------------------------------

  useEffect(() => {
    const loadSubscription = async () => {
      try {
        const sub = await apiService.getSubscription();
        setSubscription(sub);
      } catch {
        setSubscription(null);
      } finally {
        setSubLoading(false);
      }
    };
    loadSubscription();
  }, []);

  useEffect(() => {
    const loadDeployments = async () => {
      try {
        const result = await apiService.listDeployments({ customerId: user?.id });
        setDeployments(result.deployments as Deployment[]);
      } catch {
        setDeployments([]);
      } finally {
        setDeploymentsLoading(false);
      }
    };
    loadDeployments();
  }, [user?.id]);

  // -----------------------------------------------------------------------
  // Deployment polling
  // -----------------------------------------------------------------------

  const pollDeploymentStatus = useCallback(async (deploymentId: string) => {
    const startTime = Date.now();

    const poll = async () => {
      if (Date.now() - startTime > MAX_POLL_DURATION) {
        setDeployPhase('error');
        setDeployError('Deployment timed out after 10 minutes');
        return;
      }

      try {
        const status = await apiService.getDeploymentStatus(deploymentId);

        if (status.currentPhase === 'READY' && status.success) {
          setDeployPhase('ready');
          setDeployments((prev) => [
            ...prev.filter((d) => d.deploymentId !== deploymentId),
            { ...status, deploymentId },
          ]);
          return;
        }

        if (status.currentPhase === 'FAILED' || status.error) {
          setDeployPhase('error');
          setDeployError(status.error ?? 'Deployment failed');
          return;
        }

        // Continue polling
        setTimeout(poll, STATUS_POLL_INTERVAL);
      } catch (err) {
        setDeployPhase('error');
        setDeployError(err instanceof Error ? err.message : 'Failed to check deployment status');
      }
    };

    poll();
  }, []);

  // -----------------------------------------------------------------------
  // Deploy handler
  // -----------------------------------------------------------------------

  /**
   * Start a new team deployment.
   * Creates a DigitalOcean droplet and installs Crewly + Pro addon.
   */
  const handleDeploy = async () => {
    if (!teamName.trim()) return;

    setDeployPhase('deploying');
    setDeployError(null);

    try {
      const result = await apiService.createDeployment({
        dropletName: `crewly-${teamName.trim().toLowerCase().replace(/\s+/g, '-')}`,
        region: DEFAULT_REGION,
        size: DEFAULT_SIZE,
        customerId: user?.id,
        installPro: true,
        registerCloud: true,
        apiKeys: {
          crewlyCloudApiKey: undefined, // Set by backend from user's cloud config
        },
      });

      setActiveDeploymentId(result.deploymentId);
      pollDeploymentStatus(result.deploymentId);
    } catch (err) {
      setDeployPhase('error');
      setDeployError(err instanceof Error ? err.message : 'Failed to start deployment');
    }
  };

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  const planName = subscription?.plan ?? license?.plan ?? 'free';
  const isPaid = planName !== 'free';
  const readyDeployments = deployments.filter((d) => d.success && d.currentPhase === 'READY');

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background-dark px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <Cloud className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-text-primary-dark">
              Cloud Portal
            </h1>
            <p className="text-sm text-text-secondary-dark">
              Deploy and manage your Crewly teams in the cloud
            </p>
          </div>
        </div>

        {/* Upgrade Success Banner */}
        {justUpgraded && (
          <div
            className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center"
            data-testid="upgrade-success-banner"
          >
            <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-400 mb-2" />
            <h3 className="text-lg font-semibold text-emerald-400">
              Welcome to Crewly Pro!
            </h3>
            <p className="text-sm text-text-secondary-dark mt-1">
              Your subscription is active. Deploy your first AI team below to get started.
            </p>
          </div>
        )}

        {/* Subscription Status Card */}
        <div
          className="mb-6 rounded-xl border border-border-dark bg-surface-dark p-6"
          data-testid="subscription-card"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-text-primary-dark">
                Subscription
              </h2>
              {subLoading ? (
                <p className="mt-1 text-sm text-text-secondary-dark">Loading...</p>
              ) : isPaid ? (
                <div className="mt-1 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm text-emerald-400 font-medium capitalize">
                    {planName} Plan — Active
                  </span>
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-400" />
                  <span className="text-sm text-amber-400">
                    Free Plan — Upgrade to deploy teams
                  </span>
                </div>
              )}
            </div>
            {!isPaid && (
              <Button
                variant="primary"
                onClick={() => navigate('/pricing')}
                data-testid="upgrade-btn"
              >
                Upgrade Now
              </Button>
            )}
          </div>
        </div>

        {/* Deploy New Team Section */}
        {isPaid && (
          <div
            className="mb-6 rounded-xl border border-border-dark bg-surface-dark p-6"
            data-testid="deploy-section"
          >
            <div className="flex items-center gap-2 mb-4">
              <Rocket className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold text-text-primary-dark">
                Deploy a New Team
              </h2>
            </div>

            {deployPhase === 'idle' || deployPhase === 'configuring' ? (
              <div className="space-y-4">
                <p className="text-sm text-text-secondary-dark">
                  Deploy a Crewly team to the cloud. We&apos;ll create a dedicated server,
                  install Crewly OSS with Pro features, and connect it to your Cloud account.
                </p>

                <div>
                  <label
                    htmlFor="team-name"
                    className="block text-sm font-medium text-text-primary-dark mb-1"
                  >
                    Team Name
                  </label>
                  <input
                    id="team-name"
                    type="text"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder="e.g. marketing-team"
                    className="w-full rounded-lg border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark placeholder:text-text-secondary-dark focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    data-testid="team-name-input"
                  />
                </div>

                <div className="flex items-center gap-4 text-xs text-text-secondary-dark">
                  <span className="flex items-center gap-1">
                    <Server className="h-3 w-3" /> 2 vCPU / 4 GB RAM
                  </span>
                  <span className="flex items-center gap-1">
                    <Globe className="h-3 w-3" /> San Francisco (SFO3)
                  </span>
                </div>

                <Button
                  variant="primary"
                  onClick={handleDeploy}
                  disabled={!teamName.trim()}
                  data-testid="deploy-btn"
                >
                  <Rocket className="mr-2 h-4 w-4" />
                  Deploy Team
                </Button>
              </div>
            ) : deployPhase === 'deploying' ? (
              <div className="flex flex-col items-center py-8" data-testid="deploying-state">
                <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
                <h3 className="text-lg font-semibold text-text-primary-dark">
                  Deploying your team...
                </h3>
                <p className="mt-2 text-sm text-text-secondary-dark text-center max-w-md">
                  Creating server, installing Crewly OSS, adding Pro features, and connecting
                  to Cloud. This usually takes 3–5 minutes.
                </p>
                {activeDeploymentId && (
                  <p className="mt-2 text-xs text-text-secondary-dark font-mono">
                    ID: {activeDeploymentId}
                  </p>
                )}
              </div>
            ) : deployPhase === 'ready' ? (
              <div className="flex flex-col items-center py-8" data-testid="ready-state">
                <CheckCircle2 className="h-10 w-10 text-emerald-400 mb-4" />
                <h3 className="text-lg font-semibold text-text-primary-dark">
                  Team deployed successfully!
                </h3>
                <p className="mt-2 text-sm text-text-secondary-dark">
                  Your team is ready. Click below to start chatting with your AI team.
                </p>
                <Button
                  variant="primary"
                  className="mt-4"
                  onClick={() => navigate('/chat')}
                  data-testid="open-chat-btn"
                >
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Open Team Chat
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center py-8" data-testid="error-state">
                <AlertCircle className="h-10 w-10 text-red-400 mb-4" />
                <h3 className="text-lg font-semibold text-text-primary-dark">
                  Deployment failed
                </h3>
                <p className="mt-2 text-sm text-red-400">{deployError}</p>
                <Button
                  variant="secondary"
                  className="mt-4"
                  onClick={() => {
                    setDeployPhase('idle');
                    setDeployError(null);
                  }}
                  data-testid="retry-btn"
                >
                  Try Again
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Deployed Teams List */}
        <div
          className="rounded-xl border border-border-dark bg-surface-dark p-6"
          data-testid="deployments-list"
        >
          <h2 className="text-lg font-semibold text-text-primary-dark mb-4">
            Your Deployed Teams
          </h2>

          {deploymentsLoading ? (
            <div className="flex items-center gap-2 text-text-secondary-dark py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading deployments...
            </div>
          ) : readyDeployments.length === 0 ? (
            <p className="text-sm text-text-secondary-dark py-4">
              No deployed teams yet. {isPaid ? 'Deploy your first team above!' : 'Upgrade to get started.'}
            </p>
          ) : (
            <div className="space-y-3">
              {readyDeployments.map((dep) => (
                <div
                  key={dep.deploymentId}
                  className="flex items-center justify-between rounded-lg border border-border-dark bg-background-dark p-4"
                  data-testid={`deployment-${dep.deploymentId}`}
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                    <div>
                      <p className="text-sm font-medium text-text-primary-dark">
                        {dep.ipAddress ?? dep.deploymentId}
                      </p>
                      <p className="text-xs text-text-secondary-dark">
                        Phase: {dep.currentPhase}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => navigate('/chat')}
                    data-testid={`chat-btn-${dep.deploymentId}`}
                  >
                    <MessageSquare className="mr-1 h-3 w-3" />
                    Chat
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CloudPortal;
