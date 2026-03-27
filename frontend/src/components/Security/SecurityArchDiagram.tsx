/**
 * Security Architecture Diagram — Interactive 3-state diagram
 *
 * Displays one of three security architecture visualizations based on
 * the active pillar: PTY Isolation (A), Local Vector Storage (B),
 * or Granular Tool Approval (C). Per spec section 2.3.
 *
 * Supports both controlled (via activePillar prop) and internal pillar
 * switching via clickable tabs.
 *
 * @module components/Security/SecurityArchDiagram
 */

import React, { useState, useEffect } from 'react';
import { Shield, Database, CheckSquare, CheckCircle, AlertTriangle, XOctagon } from 'lucide-react';
import type { PillarId } from './SecurityPillarCard';
import { Card } from '../UI/Card';
import { Button } from '../UI/Button';

/** Props for SecurityArchDiagram */
export interface SecurityArchDiagramProps {
  /** Currently active pillar state */
  activePillar: PillarId;
  /** Optional callback when pillar is changed internally */
  onPillarChange?: (pillar: PillarId) => void;
}

/** Tab definition for internal pillar switching */
const PILLAR_TABS = [
  { id: 'pty' as PillarId, label: 'PTY Isolation', Icon: Shield },
  { id: 'storage' as PillarId, label: 'Local Storage', Icon: Database },
  { id: 'approval' as PillarId, label: 'Tool Approval', Icon: CheckSquare },
] as const;

/** Tab active color per pillar */
const TAB_COLORS: Record<PillarId, { active: string; indicator: string }> = {
  pty: { active: 'border-blue-500 text-blue-400', indicator: 'bg-blue-500' },
  storage: { active: 'border-purple-500 text-purple-400', indicator: 'bg-purple-500' },
  approval: { active: 'border-pink-500 text-pink-400', indicator: 'bg-pink-500' },
};

// ========================= State A: PTY Isolation =========================

/** Agent data for PTY isolation visualization */
const PTY_AGENTS = [
  { name: 'Sam', role: 'TL', fs: '/sam', pid: 201, color: 'border-blue-500 bg-blue-500/5' },
  { name: 'Leo', role: 'Dev', fs: '/leo', pid: 202, color: 'border-purple-500 bg-purple-500/5' },
  { name: 'Ava', role: 'UX', fs: '/ava', pid: 203, color: 'border-pink-500 bg-pink-500/5' },
] as const;

/**
 * State A — PTY Isolation diagram showing isolated agent sandboxes
 * with blocked attack paths and highlighted data flow.
 */
const PtyIsolationDiagram: React.FC<{ isTransitioning: boolean }> = ({ isTransitioning }) => (
  <div className={`space-y-4 transition-opacity duration-300 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}>
    {/* Data flow label */}
    <div className="flex items-center gap-2 mb-2">
      <div className="h-px flex-1 bg-gradient-to-r from-blue-500/50 to-transparent" />
      <span className="text-xs font-mono text-blue-400 uppercase tracking-wider" data-testid="flow-label-pty">
        Process Isolation Flow
      </span>
      <div className="h-px flex-1 bg-gradient-to-l from-blue-500/50 to-transparent" />
    </div>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {PTY_AGENTS.map((agent) => (
        <div
          key={agent.name}
          className={`rounded-lg border-2 p-4 ${agent.color} transition-all duration-300`}
          data-testid={`pty-agent-${agent.name.toLowerCase()}`}
        >
          <div className="font-mono text-sm text-zinc-300 mb-2">
            PTY #{agent.pid}
          </div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-200">
              {agent.name[0]}
            </div>
            <div>
              <div className="text-sm font-semibold text-zinc-200">{agent.name}</div>
              <div className="text-xs text-zinc-500">({agent.role})</div>
            </div>
          </div>
          <div className="space-y-1 font-mono text-xs text-zinc-500">
            <div>fs: {agent.fs}</div>
            <div>pid: {agent.pid}</div>
          </div>
          <div className="mt-3 text-xs text-red-400 font-medium flex items-center gap-1">
            <span aria-hidden="true">&#10007;</span> blocked
          </div>
        </div>
      ))}
    </div>
    <div className="flex items-center justify-center gap-2 py-2 px-4 rounded bg-red-500/10 border border-red-500/20">
      <span className="text-red-400 text-sm font-mono" aria-hidden="true">&#9632;</span>
      <span className="text-sm text-red-300">
        Attack path: Sam &rarr; Leo&ensp;
        <span className="font-bold">&#9580; BLOCKED</span>
      </span>
    </div>
  </div>
);

// ========================= State B: Local Vector Storage =========================

/** Data categories stored locally */
const STORAGE_CATEGORIES = [
  { label: 'Agent Memory', color: 'bg-emerald-500/10 border-emerald-500/30' },
  { label: 'Conversations', color: 'bg-blue-500/10 border-blue-500/30' },
  { label: 'Project Knowl.', color: 'bg-purple-500/10 border-purple-500/30' },
] as const;

/**
 * State B — Local Vector Storage diagram showing data staying on-machine
 * with no cloud connection.
 */
const LocalStorageDiagram: React.FC<{ isTransitioning: boolean }> = ({ isTransitioning }) => (
  <div className={`space-y-4 transition-opacity duration-300 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}>
    {/* Data flow label */}
    <div className="flex items-center gap-2 mb-2">
      <div className="h-px flex-1 bg-gradient-to-r from-purple-500/50 to-transparent" />
      <span className="text-xs font-mono text-purple-400 uppercase tracking-wider" data-testid="flow-label-storage">
        Data Sovereignty Flow
      </span>
      <div className="h-px flex-1 bg-gradient-to-l from-purple-500/50 to-transparent" />
    </div>

    <div className="rounded-lg border-2 border-emerald-500/30 bg-emerald-500/5 p-6">
      <div className="text-sm font-semibold text-emerald-300 mb-4">
        Local SQLite + Vectors
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        {STORAGE_CATEGORIES.map((cat) => (
          <div
            key={cat.label}
            className={`rounded border p-3 text-center text-sm text-zinc-300 ${cat.color}`}
          >
            {cat.label}
          </div>
        ))}
      </div>
      <div className="space-y-1 text-xs text-zinc-400">
        <div>All data encrypted at rest</div>
        <div>Zero cloud dependencies</div>
      </div>
    </div>
    <div className="flex items-center justify-center gap-3 py-2 px-4 rounded bg-zinc-800 border border-zinc-700">
      <span className="text-zinc-500 text-lg" aria-hidden="true">&#9729;</span>
      <span className="text-sm text-zinc-400">Cloud</span>
      <span className="text-xs text-zinc-600 font-mono">&larr; NO CONNECTION &rarr;</span>
      <span className="text-red-400" aria-hidden="true">&#10007;</span>
    </div>
    <p className="text-sm text-zinc-400 text-center italic">
      &ldquo;Your conversations, agent memory, and project knowledge never leave this machine.&rdquo;
    </p>
  </div>
);

// ========================= State C: Granular Tool Approval =========================

/** Permission matrix rows from spec section 2.3 State C */
const PERMISSION_ROWS = [
  { tool: 'read files', level: 'auto', label: 'Auto-approved', color: 'text-emerald-400', iconType: 'check' },
  { tool: 'write files', level: 'auto', label: 'Auto-approved', color: 'text-emerald-400', iconType: 'check' },
  { tool: 'npm install', level: 'ask-once', label: 'Ask once', color: 'text-yellow-400', iconType: 'warn' },
  { tool: 'git push --force', level: 'always-ask', label: 'Always ask', color: 'text-red-400', iconType: 'deny' },
  { tool: 'rm -rf', level: 'always-ask', label: 'Always ask', color: 'text-red-400', iconType: 'deny' },
] as const;

/** Map permission icon types to Lucide components */
function PermissionIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'check':
      return <CheckCircle size={14} className={className} />;
    case 'warn':
      return <AlertTriangle size={14} className={className} />;
    case 'deny':
      return <XOctagon size={14} className={className} />;
    default:
      return null;
  }
}

/**
 * State C — Granular Tool Approval diagram showing the approval prompt
 * and permission matrix.
 */
const ToolApprovalDiagram: React.FC<{ isTransitioning: boolean }> = ({ isTransitioning }) => {
  const [decision, setDecision] = useState<'pending' | 'denied' | 'approved'>('pending');

  return (
    <div className={`space-y-4 transition-opacity duration-300 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}>
      {/* Data flow label */}
      <div className="flex items-center gap-2 mb-2">
        <div className="h-px flex-1 bg-gradient-to-r from-pink-500/50 to-transparent" />
        <span className="text-xs font-mono text-pink-400 uppercase tracking-wider" data-testid="flow-label-approval">
          Approval Gate Flow
        </span>
        <div className="h-px flex-1 bg-gradient-to-l from-pink-500/50 to-transparent" />
      </div>

      {/* Approval prompt */}
      <Card variant="outlined" padding="lg" className="bg-zinc-900">
        <div className="text-sm text-zinc-400 mb-3">
          Agent &ldquo;Sam&rdquo; wants to execute:
        </div>
        <div className="font-mono text-sm text-zinc-200 bg-zinc-800 rounded px-3 py-2 mb-3">
          $ git push --force origin main
        </div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs font-medium uppercase tracking-wide text-red-400">
            Risk Level:
          </span>
          <div className="flex-1 h-2 rounded-full bg-zinc-700 overflow-hidden">
            <div className="h-full w-full bg-red-500 rounded-full" />
          </div>
          <span className="text-xs font-bold text-red-400">HIGH</span>
        </div>
        <div className="text-xs text-zinc-400 mb-4 space-y-1">
          <div className="font-medium text-zinc-300">Why flagged:</div>
          <div>&bull; Destructive operation (--force)</div>
          <div>&bull; Targets protected branch (main)</div>
          <div>&bull; Cannot be undone</div>
        </div>
        <div className="flex gap-3">
          <Button
            variant={decision === 'denied' ? 'danger' : 'outline'}
            size="sm"
            onClick={() => setDecision('denied')}
            aria-label="Deny this tool execution"
          >
            Deny
          </Button>
          <Button
            variant={decision === 'approved' ? 'success' : 'outline'}
            size="sm"
            onClick={() => setDecision('approved')}
            aria-label="Approve this tool execution"
          >
            Approve
          </Button>
        </div>
        {decision !== 'pending' && (
          <div
            className={`mt-3 text-xs font-medium ${
              decision === 'denied' ? 'text-red-400' : 'text-emerald-400'
            }`}
            role="status"
            aria-live="polite"
          >
            {decision === 'denied' ? 'Execution denied — agent notified.' : 'Execution approved — proceeding.'}
          </div>
        )}
      </Card>

      {/* Permission matrix */}
      <Card variant="outlined" padding="md" className="bg-zinc-900">
        <div className="text-sm font-semibold text-zinc-300 mb-3">Permission Matrix:</div>
        <div className="space-y-2" role="list" aria-label="Permission matrix">
          {PERMISSION_ROWS.map((row) => (
            <div
              key={row.tool}
              className="flex items-center justify-between text-sm py-1 px-2 rounded hover:bg-zinc-800 transition-colors"
              role="listitem"
            >
              <span className="font-mono text-zinc-400">{row.tool}</span>
              <span className="flex items-center gap-2 text-xs">
                <span className="text-zinc-600" aria-hidden="true">
                  {'·'.repeat(12)}
                </span>
                <span className={`flex items-center gap-1 ${row.color}`}>
                  <PermissionIcon type={row.iconType} className={row.color} />
                  {row.label}
                </span>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

// ========================= Main Component =========================

/** Maps pillar ID to descriptive label for screen readers */
const PILLAR_LABELS: Record<PillarId, string> = {
  pty: 'PTY Isolation: Each agent runs in its own isolated pseudo-terminal with separate filesystem and process boundaries, preventing lateral movement between agents.',
  storage: 'Local Vector Storage: All data including agent memory, conversations, and project knowledge is stored locally with zero cloud dependencies.',
  approval: 'Granular Tool Approval: Every tool execution is classified by risk level and requires appropriate approval before proceeding.',
};

/**
 * Interactive 3-state architecture diagram that visualizes the active
 * security pillar. Includes clickable tabs for pillar switching and
 * animated transitions between states.
 *
 * @param props - SecurityArchDiagramProps
 * @returns Architecture diagram element
 */
export const SecurityArchDiagram: React.FC<SecurityArchDiagramProps> = ({ activePillar, onPillarChange }) => {
  const [internalPillar, setInternalPillar] = useState<PillarId>(activePillar);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Sync internal state when prop changes
  useEffect(() => {
    if (activePillar !== internalPillar) {
      setIsTransitioning(true);
      const timer = setTimeout(() => {
        setInternalPillar(activePillar);
        setIsTransitioning(false);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [activePillar, internalPillar]);

  /**
   * Handle tab click — animate transition and update state.
   */
  const handleTabClick = (pillar: PillarId) => {
    if (pillar === internalPillar) return;
    setIsTransitioning(true);
    setTimeout(() => {
      setInternalPillar(pillar);
      setIsTransitioning(false);
      onPillarChange?.(pillar);
    }, 150);
  };

  return (
    <Card
      id="security-arch-diagram"
      variant="default"
      padding="lg"
      role="img"
      aria-label={PILLAR_LABELS[internalPillar]}
      data-testid="security-arch-diagram"
    >
      {/* Machine boundary header */}
      <div className="text-xs font-mono text-zinc-500 mb-4 uppercase tracking-wider">
        Your Machine
      </div>

      {/* Interactive pillar tabs */}
      <div
        className="flex gap-1 mb-6 border-b border-zinc-800 -mx-2 px-2"
        role="tablist"
        aria-label="Security pillar selector"
        data-testid="pillar-tabs"
      >
        {PILLAR_TABS.map(({ id, label, Icon }) => {
          const isActive = internalPillar === id;
          const colors = TAB_COLORS[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="security-arch-content"
              onClick={() => handleTabClick(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                isActive
                  ? colors.active
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
              data-testid={`tab-${id}`}
            >
              <Icon size={14} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Render active state */}
      <div id="security-arch-content" role="tabpanel" className="motion-safe:animate-fade-in">
        {internalPillar === 'pty' && <PtyIsolationDiagram isTransitioning={isTransitioning} />}
        {internalPillar === 'storage' && <LocalStorageDiagram isTransitioning={isTransitioning} />}
        {internalPillar === 'approval' && <ToolApprovalDiagram isTransitioning={isTransitioning} />}
      </div>

      {/* Screen reader text alternative */}
      <div className="sr-only">
        {PILLAR_LABELS[internalPillar]}
      </div>
    </Card>
  );
};

SecurityArchDiagram.displayName = 'SecurityArchDiagram';
