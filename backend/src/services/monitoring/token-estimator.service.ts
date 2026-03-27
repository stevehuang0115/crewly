/**
 * Token Estimation Engine
 *
 * Calculates deployment quotes and pre-execution token estimates based on
 * team templates, model pricing, task complexity, and historical data.
 * Supports Phase 3 O8 KR1 objectives.
 *
 * @module services/monitoring/token-estimator.service
 */

import fs from 'fs/promises';
import * as path from 'path';
import { BUDGET_CONSTANTS } from '../../types/budget.types.js';
import { MODEL_CONTEXT_WINDOWS } from '../agent/crewly-agent/types.js';

/** Path to the cloud deployment manifest */
const CLOUD_DEPLOY_MANIFEST = 'config/templates/cloud-deploy.json';

/** Templates directory for local template files */
const TEMPLATES_DIR = 'config/templates';

/** Default service fee (15%) */
const SERVICE_FEE_MULTIPLIER = 1.15;

// ── Estimation Constants ─────────────────────────────────────────────────────

/** Average tokens per system prompt character (approx 1 token per 4 chars) */
const TOKENS_PER_CHAR = 0.25;

/** Base system prompt token estimate when actual prompt is unavailable */
const DEFAULT_SYSTEM_PROMPT_TOKENS = 2000;

/** Estimated overhead tokens per tool call (tool definition + call/response framing) */
const TOOL_CALL_OVERHEAD_TOKENS = 150;

/** Base tokens per conversation turn (user message + assistant response framing) */
const BASE_TOKENS_PER_TURN = 500;

/** Estimated conversation turns by task complexity */
const COMPLEXITY_TURN_MAP: Record<TaskComplexity, number> = {
  simple: 5,
  moderate: 15,
  complex: 40,
  very_complex: 80,
};

/** Input/output ratio by complexity (output fraction of total) */
const OUTPUT_RATIO_MAP: Record<TaskComplexity, number> = {
  simple: 0.6,
  moderate: 0.55,
  complex: 0.5,
  very_complex: 0.45,
};

/** Model-specific token efficiency multipliers relative to a baseline */
const MODEL_EFFICIENCY_MULTIPLIER: Record<string, number> = {
  // Larger context models tend to use more tokens per task
  'claude-opus-4-20250514': 1.4,
  'claude-sonnet-4-20250514': 1.0,
  'claude-haiku-4-20250506': 0.7,
  'gemini-2.0-flash': 0.8,
  'gemini-2.5-flash-preview-05-20': 0.8,
  'gemini-3-flash-preview': 0.8,
  'gpt-4o': 1.1,
  'gpt-4o-mini': 0.75,
  'gpt-4-turbo': 1.2,
  default: 1.0,
};

/** Historical calibration weight (0-1): how much to weight historical data vs heuristic */
const HISTORICAL_CALIBRATION_WEIGHT = 0.7;

/** Minimum number of historical events needed to use calibration */
const MIN_HISTORICAL_EVENTS = 3;

// ── Types ────────────────────────────────────────────────────────────────────

/** Task complexity levels for estimation */
export type TaskComplexity = 'simple' | 'moderate' | 'complex' | 'very_complex';

/** Template role definition used for estimation */
export interface TemplateRole {
  role: string;
  label?: string;
  count: number;
  defaultTools?: string[];
  modelConfig?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
}

/** Parsed template structure for estimation */
export interface TemplateInfo {
  id: string;
  name: string;
  roles: TemplateRole[];
}

/** Request body for the estimate-tokens endpoint */
export interface EstimateTokensRequest {
  templateId: string;
  objective: string;
  modelId?: string;
}

/** Response from the estimate-tokens endpoint */
export interface TokenEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  confidence: 'low' | 'medium' | 'high';
  breakdown: {
    systemPromptTokens: number;
    toolOverheadTokens: number;
    conversationTokens: number;
    agentCount: number;
    estimatedTurns: number;
    taskComplexity: TaskComplexity;
    modelMultiplier: number;
    historicalCalibration: boolean;
  };
}

/** Quote result structure */
export interface DeploymentQuote {
  templateId: string;
  templateName: string;
  agentCount: number;
  estimatedCostPerTask: number;
  estimatedDailyBudget: number;
  serviceFee: number;
  totalEstimatedCost: number;
  modelBreakdown: Array<{
    model: string;
    percentage: number;
    costPerMillion: number;
  }>;
  currency: string;
}

/** Historical usage record for calibration */
export interface HistoricalUsageRecord {
  totalInput: number;
  totalOutput: number;
  eventCount: number;
}

/**
 * Service for estimating token usage costs before deployment.
 *
 * Provides two estimation modes:
 * 1. Deployment quotes (getQuote) — cost-focused estimates from cloud manifest
 * 2. Task token estimates (estimateTokens) — granular per-task predictions
 *    using template analysis, task complexity heuristics, and historical calibration
 */
export class TokenEstimatorService {
  private static instance: TokenEstimatorService | null = null;
  private projectPath: string;

  /**
   * Optional function to retrieve historical usage data for calibration.
   * Injected via setHistoricalDataProvider() to avoid circular dependency
   * with TokenUsageService.
   */
  private historicalDataProvider:
    | (() => HistoricalUsageRecord[])
    | null = null;

  constructor(projectPath?: string) {
    this.projectPath = projectPath ?? process.cwd();
  }

  /**
   * Get the singleton TokenEstimatorService instance.
   *
   * @param projectPath - Optional project path override
   * @returns The shared TokenEstimatorService instance
   */
  static getInstance(projectPath?: string): TokenEstimatorService {
    if (!TokenEstimatorService.instance) {
      TokenEstimatorService.instance = new TokenEstimatorService(projectPath);
    }
    return TokenEstimatorService.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   */
  static resetInstance(): void {
    TokenEstimatorService.instance = null;
  }

  /**
   * Set the historical data provider for calibration.
   *
   * The provider function should return an array of historical usage records
   * (e.g. from TokenUsageService.getUsageBySessions()).
   *
   * @param provider - Function that returns historical usage records
   */
  setHistoricalDataProvider(provider: () => HistoricalUsageRecord[]): void {
    this.historicalDataProvider = provider;
  }

  // ── Task Token Estimation ────────────────────────────────────────────────

  /**
   * Estimate token consumption for a task before execution.
   *
   * Algorithm:
   * 1. Load the template and count agents + tools per role
   * 2. Estimate system prompt tokens per agent
   * 3. Classify task complexity from the objective text
   * 4. Calculate per-turn token overhead (tools + conversation)
   * 5. Multiply by expected turns for the complexity level
   * 6. Apply model-specific efficiency multiplier
   * 7. If historical data exists, calibrate the estimate
   *
   * @param request - The estimation request (templateId, objective, optional modelId)
   * @returns Token estimate with cost and confidence
   * @throws Error if template cannot be loaded
   */
  async estimateTokens(request: EstimateTokensRequest): Promise<TokenEstimate> {
    const { templateId, objective, modelId } = request;

    // 1. Load template
    const template = await this.loadTemplate(templateId);
    const totalAgents = template.roles.reduce((sum, r) => sum + r.count, 0);

    // 2. Estimate system prompt tokens per agent
    const systemPromptTokens = this.estimateSystemPromptTokens(template);

    // 3. Classify task complexity
    const complexity = this.classifyComplexity(objective);
    const estimatedTurns = COMPLEXITY_TURN_MAP[complexity];

    // 4. Resolve the model and its multiplier
    const resolvedModelId = modelId
      ?? template.roles[0]?.modelConfig?.model
      ?? 'claude-sonnet-4-20250514';
    const modelMultiplier = MODEL_EFFICIENCY_MULTIPLIER[resolvedModelId]
      ?? MODEL_EFFICIENCY_MULTIPLIER.default;

    // 5. Calculate tool overhead
    const totalToolsAcrossAgents = template.roles.reduce(
      (sum, r) => sum + (r.defaultTools?.length ?? 0) * r.count,
      0,
    );
    // Not every turn uses a tool; estimate ~60% of turns involve tool calls
    const toolCallsPerTurn = Math.ceil(totalToolsAcrossAgents * 0.6 / totalAgents);
    const toolOverheadTokens = toolCallsPerTurn * TOOL_CALL_OVERHEAD_TOKENS * estimatedTurns;

    // 6. Calculate conversation tokens
    const conversationTokens = BASE_TOKENS_PER_TURN * estimatedTurns * totalAgents;

    // 7. Total raw tokens (before model multiplier)
    const rawTotal = (systemPromptTokens + toolOverheadTokens + conversationTokens) * modelMultiplier;

    // 8. Split into input/output based on complexity
    const outputRatio = OUTPUT_RATIO_MAP[complexity];
    let estimatedOutputTokens = Math.round(rawTotal * outputRatio);
    let estimatedInputTokens = Math.round(rawTotal * (1 - outputRatio));

    // 9. Historical calibration
    let historicalCalibration = false;
    const historicalData = this.getHistoricalData();
    if (historicalData && historicalData.length >= MIN_HISTORICAL_EVENTS) {
      const avgHistoricalInput = historicalData.reduce((s, h) => s + h.totalInput, 0) / historicalData.length;
      const avgHistoricalOutput = historicalData.reduce((s, h) => s + h.totalOutput, 0) / historicalData.length;

      if (avgHistoricalInput > 0 && avgHistoricalOutput > 0) {
        estimatedInputTokens = Math.round(
          estimatedInputTokens * (1 - HISTORICAL_CALIBRATION_WEIGHT)
          + avgHistoricalInput * HISTORICAL_CALIBRATION_WEIGHT,
        );
        estimatedOutputTokens = Math.round(
          estimatedOutputTokens * (1 - HISTORICAL_CALIBRATION_WEIGHT)
          + avgHistoricalOutput * HISTORICAL_CALIBRATION_WEIGHT,
        );
        historicalCalibration = true;
      }
    }

    // 10. Calculate cost
    const costs = BUDGET_CONSTANTS.TOKEN_COSTS[resolvedModelId]
      ?? BUDGET_CONSTANTS.TOKEN_COSTS.default;
    const estimatedCost = Number(
      (estimatedInputTokens * costs.input + estimatedOutputTokens * costs.output).toFixed(4),
    );

    // 11. Determine confidence
    const confidence = this.determineConfidence(complexity, historicalCalibration, totalAgents);

    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCost,
      confidence,
      breakdown: {
        systemPromptTokens,
        toolOverheadTokens,
        conversationTokens,
        agentCount: totalAgents,
        estimatedTurns,
        taskComplexity: complexity,
        modelMultiplier,
        historicalCalibration,
      },
    };
  }

  /**
   * Load a template from the templates directory.
   *
   * Searches for template.json in the template directory, then falls back
   * to a top-level {templateId}.json file.
   *
   * @param templateId - Template identifier (directory name or file stem)
   * @returns Parsed template info
   * @throws Error if template cannot be found or parsed
   */
  async loadTemplate(templateId: string): Promise<TemplateInfo> {
    const templatesDir = path.join(this.projectPath, TEMPLATES_DIR);

    // Try directory-based template first (e.g. config/templates/dev-fullstack/template.json)
    const dirPath = path.join(templatesDir, templateId, 'template.json');
    try {
      const raw = await fs.readFile(dirPath, 'utf-8');
      const data = JSON.parse(raw);
      return {
        id: data.id ?? templateId,
        name: data.name ?? templateId,
        roles: (data.roles ?? []) as TemplateRole[],
      };
    } catch {
      // Not a directory-based template — try file-based
    }

    // Try file-based template (e.g. config/templates/dev-fullstack.json)
    const filePath = path.join(templatesDir, `${templateId}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return {
        id: data.id ?? templateId,
        name: data.name ?? templateId,
        roles: (data.roles ?? data.members ?? []).map((m: Record<string, unknown>) => ({
          role: m.role ?? m.name ?? 'agent',
          label: m.label ?? m.name,
          count: (m.count as number) ?? 1,
          defaultTools: m.defaultTools ?? m.tools ?? [],
          modelConfig: m.modelConfig,
        })) as TemplateRole[],
      };
    } catch {
      throw new Error(`Template not found: ${templateId}`);
    }
  }

  /**
   * Estimate system prompt tokens across all agents in a template.
   *
   * Uses DEFAULT_SYSTEM_PROMPT_TOKENS per agent as a baseline, scaled by
   * the number of tools (more tools = longer tool definitions in the prompt).
   *
   * @param template - Parsed template info
   * @returns Total estimated system prompt tokens across all agents
   */
  estimateSystemPromptTokens(template: TemplateInfo): number {
    let total = 0;
    for (const role of template.roles) {
      const toolCount = role.defaultTools?.length ?? 0;
      // Base prompt + ~50 tokens per tool definition
      const perAgent = DEFAULT_SYSTEM_PROMPT_TOKENS + toolCount * 50;
      total += perAgent * role.count;
    }
    return total;
  }

  /**
   * Classify task complexity from the objective text.
   *
   * Heuristic based on:
   * - Text length (longer descriptions → more complex tasks)
   * - Presence of complexity keywords
   *
   * @param objective - Task description / objective text
   * @returns Estimated task complexity level
   */
  classifyComplexity(objective: string): TaskComplexity {
    const lower = objective.toLowerCase();
    const wordCount = objective.split(/\s+/).filter(Boolean).length;

    // Keyword-based signals
    const complexKeywords = [
      'refactor', 'architect', 'migration', 'redesign', 'full-stack',
      'microservice', 'infrastructure', 'security audit', 'performance',
      'database schema', 'api design', 'ci/cd', 'deploy',
    ];
    const simpleKeywords = [
      'fix typo', 'update readme', 'rename', 'add comment',
      'change color', 'bump version', 'simple', 'minor',
    ];

    const hasComplexSignal = complexKeywords.some(k => lower.includes(k));
    const hasSimpleSignal = simpleKeywords.some(k => lower.includes(k));

    if (hasSimpleSignal && !hasComplexSignal && wordCount < 20) {
      return 'simple';
    }
    if (hasComplexSignal && wordCount > 25) {
      return 'very_complex';
    }
    if (hasComplexSignal || wordCount > 30) {
      return 'complex';
    }
    if (wordCount > 15) {
      return 'moderate';
    }
    return 'simple';
  }

  /**
   * Determine estimate confidence level.
   *
   * Higher confidence when:
   * - Historical calibration data is available
   * - Task complexity is lower (more predictable)
   * - Template has fewer agents (less variance)
   *
   * @param complexity - Task complexity
   * @param hasHistorical - Whether historical calibration was applied
   * @param agentCount - Number of agents in the template
   * @returns Confidence level
   */
  determineConfidence(
    complexity: TaskComplexity,
    hasHistorical: boolean,
    agentCount: number,
  ): 'low' | 'medium' | 'high' {
    let score = 0;

    // Historical data is the strongest confidence signal
    if (hasHistorical) score += 3;

    // Simpler tasks are more predictable
    if (complexity === 'simple') score += 2;
    else if (complexity === 'moderate') score += 1;

    // Fewer agents = more predictable
    if (agentCount <= 2) score += 1;

    if (score >= 4) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }

  // ── Historical Data ──────────────────────────────────────────────────────

  /**
   * Get historical usage data for calibration.
   *
   * @returns Array of historical usage records, or null if no provider set
   */
  private getHistoricalData(): HistoricalUsageRecord[] | null {
    if (!this.historicalDataProvider) return null;
    try {
      return this.historicalDataProvider();
    } catch {
      return null;
    }
  }

  // ── Deployment Quotes (existing functionality) ───────────────────────────

  /**
   * Calculate a deployment quote for a specific template.
   *
   * @param templateId - ID of the team template
   * @returns Detailed deployment quote
   * @throws Error if template not found or manifest missing
   */
  async getQuote(templateId: string): Promise<DeploymentQuote> {
    const manifestPath = path.join(this.projectPath, CLOUD_DEPLOY_MANIFEST);
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    const template = manifest.templates.find((t: Record<string, unknown>) => t.templateId === templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const { perTaskAvg, dailyBudget, modelBreakdown } = template.estimatedTokenUsage;

    // Calculate weighted cost per 1M tokens based on model breakdown
    let weightedCostPerMillion = 0;
    const modelDetails = [];

    for (const [modelId, percentage] of Object.entries(modelBreakdown)) {
      const costs = BUDGET_CONSTANTS.TOKEN_COSTS[modelId] || BUDGET_CONSTANTS.TOKEN_COSTS.default;
      // Blended rate: (input_cost * 0.5 + output_cost * 0.5) * 1,000,000
      const blendedRate = (costs.input * 0.5 + costs.output * 0.5) * 1_000_000;

      weightedCostPerMillion += (blendedRate * (percentage as number)) / 100;

      modelDetails.push({
        model: modelId,
        percentage: percentage as number,
        costPerMillion: blendedRate,
      });
    }

    const baseCostPerTask = (perTaskAvg / 1_000_000) * weightedCostPerMillion;
    const baseDailyBudget = (dailyBudget / 1_000_000) * weightedCostPerMillion;

    const totalWithFee = baseDailyBudget * SERVICE_FEE_MULTIPLIER;
    const feeAmount = totalWithFee - baseDailyBudget;

    return {
      templateId: template.templateId,
      templateName: template.displayName,
      agentCount: template.agentCount,
      estimatedCostPerTask: Number(baseCostPerTask.toFixed(4)),
      estimatedDailyBudget: Number(baseDailyBudget.toFixed(2)),
      serviceFee: Number(feeAmount.toFixed(2)),
      totalEstimatedCost: Number(totalWithFee.toFixed(2)),
      modelBreakdown: modelDetails,
      currency: 'USD',
    };
  }

  /**
   * Get quotes for all available cloud templates.
   *
   * @returns Array of deployment quotes for each template in the manifest
   */
  async getAllQuotes(): Promise<DeploymentQuote[]> {
    const manifestPath = path.join(this.projectPath, CLOUD_DEPLOY_MANIFEST);
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    const quotes = [];
    for (const template of manifest.templates) {
      quotes.push(await this.getQuote(template.templateId));
    }
    return quotes;
  }
}
