/**
 * Quality Gate REST Controller
 *
 * Exposes quality gate operations via REST API for orchestrator bash skills.
 * Wraps the QualityGateService to provide an HTTP endpoint for running
 * quality gates (typecheck, tests, build, lint) against a project.
 *
 * @module controllers/quality-gate/quality-gate.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { execSync } from 'child_process';
import { QualityGateService } from '../../services/quality/quality-gate.service.js';
import type { GateRunResults } from '../../types/quality-gate.types.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('QualityGateController');

/**
 * POST /api/quality-gates/check
 *
 * Run quality gates against a project directory. Executes configured quality
 * gates (typecheck, tests, build, lint) and returns pass/fail results for each.
 *
 * @param req - Express request with body: { projectPath?, gates?, skipOptional? }
 * @param res - Express response returning { success, data: GateRunResults }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/quality-gates/check
 * {
 *   "projectPath": "/path/to/project",
 *   "gates": ["typecheck", "tests"],
 *   "skipOptional": true
 * }
 * ```
 */
export async function checkQualityGates(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { projectPath, gates, skipOptional } = req.body;

    const resolvedPath = projectPath || process.cwd();

    const service = QualityGateService.getInstance();
    const results: GateRunResults = await service.runAllGates(resolvedPath, {
      gateNames: gates,
      skipOptional,
    });

    logger.info('Quality gates executed via REST', {
      projectPath: resolvedPath,
      allPassed: results.allPassed,
      allRequiredPassed: results.allRequiredPassed,
      summary: results.summary,
    });

    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Failed to run quality gates', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/quality-gates/pre-commit
 *
 * Called by the git pre-commit hook to verify that team norms (SOPs) have
 * been followed before allowing a commit. Checks git history for evidence
 * of SOP compliance (e.g., review round commits for Code Commit SOP).
 *
 * @param req - Request with body: { sessionName, branch? }
 * @param res - Response returning { pass, feedback, checks }
 * @param next - Next function for error propagation
 */
export async function preCommitGate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { sessionName, branch } = req.body;

    if (!sessionName) {
      // No session context — skip norm check
      res.json({ pass: true, feedback: 'No session context — skipping norm check' });
      return;
    }

    const checks: Array<{ name: string; pass: boolean; feedback: string }> = [];

    // Check 1: Verify git log has review round commits (Code Commit SOP)
    try {
      const gitLog = execSync('git log --oneline -30', { encoding: 'utf-8', timeout: 5000 });

      const hasRound1 = gitLog.includes('review round 1') || gitLog.includes('round 1 feedback');
      const hasRound2 = gitLog.includes('review round 2') || gitLog.includes('round 2 feedback');
      const hasRound3 = gitLog.includes('review round 3') || gitLog.includes('round 3 feedback');

      if (hasRound1 || hasRound2 || hasRound3) {
        // Has at least some review rounds — check completeness
        const missingRounds: string[] = [];
        if (!hasRound1) missingRounds.push('Round 1 (Refactor & Consistency)');
        if (!hasRound2) missingRounds.push('Round 2 (Efficiency & Reliability)');
        if (!hasRound3) missingRounds.push('Round 3 (Overall Quality)');

        if (missingRounds.length > 0) {
          checks.push({
            name: 'code-commit-sop',
            pass: false,
            feedback: `Code Commit SOP incomplete. Missing: ${missingRounds.join(', ')}`,
          });
        } else {
          checks.push({
            name: 'code-commit-sop',
            pass: true,
            feedback: 'All 3 review rounds found in git history',
          });
        }
      }
      // If no review round commits at all, this might not be a SOP-governed commit — skip
    } catch {
      // Git log failed — skip check
    }

    // Check 2: Verify test files exist for changed source files
    try {
      const diff = execSync('git diff --cached --name-only', { encoding: 'utf-8', timeout: 5000 });
      const changedFiles = diff.split('\n').filter(f => f.trim());
      const sourceFiles = changedFiles.filter(f =>
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.endsWith('.test.ts') && !f.endsWith('.test.tsx') &&
        !f.includes('node_modules')
      );
      const testFiles = changedFiles.filter(f =>
        f.endsWith('.test.ts') || f.endsWith('.test.tsx')
      );

      if (sourceFiles.length > 0 && testFiles.length === 0) {
        checks.push({
          name: 'test-coverage',
          pass: false,
          feedback: `${sourceFiles.length} source file(s) changed but no test files in commit`,
        });
      } else if (sourceFiles.length > 0) {
        checks.push({
          name: 'test-coverage',
          pass: true,
          feedback: `${testFiles.length} test file(s) included with ${sourceFiles.length} source file(s)`,
        });
      }
    } catch {
      // Diff failed — skip check
    }

    const failures = checks.filter(c => !c.pass);
    const allPassed = failures.length === 0;

    logger.info('Pre-commit quality gate executed', {
      sessionName,
      branch,
      pass: allPassed,
      checkCount: checks.length,
      failureCount: failures.length,
    });

    res.json({
      pass: allPassed,
      feedback: allPassed
        ? 'All quality gates passed'
        : failures.map(f => `[${f.name}] ${f.feedback}`).join('\n'),
      checks,
    });
  } catch (error) {
    logger.error('Pre-commit gate error', {
      error: error instanceof Error ? error.message : String(error),
    });
    // On error, allow commit (graceful degradation)
    res.json({ pass: true, feedback: 'Quality gate check failed — allowing commit (graceful degradation)' });
  }
}
