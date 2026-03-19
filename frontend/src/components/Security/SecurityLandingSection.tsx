/**
 * Security Landing Section — Container for the security moat landing page
 *
 * Composes SecurityPillarCard, SecurityArchDiagram, ComparisonStrip, and
 * CTA into a full landing page section. Per spec section 2.
 *
 * @module components/Security/SecurityLandingSection
 */

import React, { useState, useCallback } from 'react';
import { Shield, Database, CheckSquare } from 'lucide-react';
import { SecurityPillarCard, type PillarId } from './SecurityPillarCard';
import { SecurityArchDiagram } from './SecurityArchDiagram';
import { ComparisonStrip } from './ComparisonStrip';

/** Pillar definitions matching spec section 2.1 */
const PILLARS = [
  {
    id: 'pty' as PillarId,
    icon: Shield,
    title: 'PTY Isolation',
    description: 'Every agent in its own sandbox. Zero lateral movement.',
  },
  {
    id: 'storage' as PillarId,
    icon: Database,
    title: 'Local Vector Storage',
    description: 'Your data never leaves your machine. 100% data sovereignty.',
  },
  {
    id: 'approval' as PillarId,
    icon: CheckSquare,
    title: 'Granular Tool Approval',
    description: 'See and approve every action before it happens.',
  },
] as const;

/** GitHub repository URL */
const GITHUB_URL = 'https://github.com/crewly-ai/crewly';
/** Documentation URL */
const DOCS_URL = 'https://docs.crewlyai.com';

/**
 * Full security landing page section that composes all sub-components
 * into a responsive layout with header, pillar cards, interactive diagram,
 * comparison strip, and CTA.
 *
 * @returns SecurityLandingSection element
 */
export const SecurityLandingSection: React.FC = () => {
  const [activePillar, setActivePillar] = useState<PillarId>('pty');
  const [copied, setCopied] = useState(false);

  const handleSeeHow = useCallback((id: PillarId) => {
    setActivePillar(id);
    // Scroll diagram into view
    const el = document.getElementById('security-arch-diagram');
    if (el?.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText('npx crewly init');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select text for manual copy
    }
  }, []);

  return (
    <section
      className="py-16 px-4 md:px-8 lg:px-16"
      aria-labelledby="security-section-heading"
      data-testid="security-landing-section"
    >
      {/* ========================= Section Header ========================= */}
      <div className="text-center mb-12">
        <h2
          id="security-section-heading"
          className="text-2xl md:text-3xl font-bold text-zinc-100 mb-3"
        >
          Security Isn&apos;t a Feature. It&apos;s the Architecture.
        </h2>
        <p className="text-zinc-400 text-base md:text-lg max-w-2xl mx-auto">
          Three layers of protection, designed before day one.
        </p>
      </div>

      {/* ========================= Pillar Cards ========================= */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
        {PILLARS.map((pillar) => (
          <SecurityPillarCard
            key={pillar.id}
            id={pillar.id}
            icon={pillar.icon}
            title={pillar.title}
            description={pillar.description}
            isActive={activePillar === pillar.id}
            onSeeHow={handleSeeHow}
          />
        ))}
      </div>

      {/* ========================= Architecture Diagram ========================= */}
      <div className="mb-10">
        <SecurityArchDiagram activePillar={activePillar} onPillarChange={setActivePillar} />
      </div>

      {/* ========================= Comparison Strip ========================= */}
      <div className="mb-10 py-8 px-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
        <ComparisonStrip />
      </div>

      {/* ========================= CTA Section ========================= */}
      <div className="text-center py-8" data-testid="security-cta">
        <h3 className="text-xl font-bold text-zinc-100 mb-4">
          Get started in one command
        </h3>

        {/* Command + Copy */}
        <div className="inline-flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 mb-6">
          <span className="text-zinc-500 select-none" aria-hidden="true">$</span>
          <code className="font-mono text-sm text-emerald-300">npx crewly init</code>
          <button
            type="button"
            onClick={handleCopy}
            className="ml-2 px-3 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors border border-zinc-600"
            aria-label={copied ? 'Copied to clipboard' : 'Copy command to clipboard'}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Links */}
        <div className="flex items-center justify-center gap-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            View on GitHub
          </a>
          <span className="text-zinc-700" aria-hidden="true">|</span>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Read Docs
          </a>
        </div>
      </div>
    </section>
  );
};

SecurityLandingSection.displayName = 'SecurityLandingSection';
