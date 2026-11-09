/**
 * Report generator — produces human-readable markdown reports
 * from eval results and scorecards.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalResult, RuntimeScorecard } from '../types/eval.types.js';

/**
 * Generate a markdown report from eval results.
 *
 * @param scorecards - Runtime scorecards to include in the report
 * @param outputDir - Directory to save the report
 * @returns Path to the generated report file
 */
export async function generateReport(
  scorecards: RuntimeScorecard[],
  outputDir: string
): Promise<string> {
  const lines: string[] = [];

  lines.push('# Crewly Agent Eval Report');
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Runtime | Normalized Score | Tasks | Avg D1 | Avg D2 | Avg D3 | Avg D4 | Total Cost | Total Time |');
  lines.push('|---------|-----------------|-------|--------|--------|--------|--------|------------|------------|');

  for (const sc of scorecards) {
    const tasks = sc.taskResults.length;
    lines.push(
      `| ${sc.runtime} | **${sc.normalizedScore}** | ${tasks} | ${sc.avgDimensionScores.d1Correctness} | ${sc.avgDimensionScores.d2CodeQuality} | ${sc.avgDimensionScores.d3Reasoning} | ${sc.avgDimensionScores.d4Autonomy} | $${sc.totalCostUsd.toFixed(3)} | ${formatDuration(sc.totalDurationSeconds)} |`
    );
  }
  lines.push('');

  // Per-runtime details
  for (const sc of scorecards) {
    lines.push(`## ${sc.runtime}`);
    lines.push('');
    lines.push(`**Normalized Score: ${sc.normalizedScore}/100**`);
    lines.push('');

    lines.push('| Task | Score | Completion | D1 | D2 | D3 | D4 | D5 | D6 | D7 | Duration | Cost |');
    lines.push('|------|-------|------------|----|----|----|----|----|----|----|---------|----- |');

    for (const r of sc.taskResults) {
      lines.push(
        `| ${r.taskId} | **${r.overallScore}** | ${r.completionType} | ${r.scores.d1Correctness} | ${r.scores.d2CodeQuality} | ${r.scores.d3Reasoning} | ${r.scores.d4Autonomy} | ${r.scores.d5ContextMgmt} | ${r.scores.d6Collaboration} | ${r.scores.d7CostEfficiency} | ${formatDuration(r.durationSeconds)} | $${r.estimatedCostUsd.toFixed(3)} |`
      );
    }
    lines.push('');

    // Verification details
    for (const r of sc.taskResults) {
      if (r.verificationResults.length > 0) {
        lines.push(`### ${r.taskId} Verification`);
        for (const v of r.verificationResults) {
          lines.push(`- ${v.passed ? '✅' : '❌'} **${v.name}**: exit code ${v.exitCode}`);
        }
        lines.push('');
      }
    }
  }

  // Methodology note
  lines.push('## Methodology');
  lines.push('');
  lines.push('Scoring uses 7 dimensions weighted as follows:');
  lines.push('- D1 Correctness (25%): Automated test/verification pass rate');
  lines.push('- D2 Code Quality (15%): TypeScript compilation + linting');
  lines.push('- D3 Reasoning (20%): Step efficiency vs expert baseline');
  lines.push('- D4 Autonomy (15%): Completion without human intervention');
  lines.push('- D5 Context Mgmt (10%): Tool call efficiency');
  lines.push('- D6 Collaboration (5%): Multi-agent coordination (Crewly only)');
  lines.push('- D7 Cost Efficiency (10%): Cost vs baseline');
  lines.push('');
  lines.push('Normalized score: Claude Code Opus = 100 baseline.');
  lines.push('');

  const content = lines.join('\n');
  const reportPath = join(outputDir, `eval-report-${Date.now()}.md`);
  await writeFile(reportPath, content, 'utf-8');

  return reportPath;
}

/**
 * Format duration in seconds to human-readable string.
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m${sec}s`;
}

/**
 * Print results summary to console.
 */
export function printResultsSummary(results: EvalResult[]): void {
  console.log('\n=== Eval Results Summary ===\n');

  for (const r of results) {
    const checks = r.verificationResults;
    const passed = checks.filter((c) => c.passed).length;
    console.log(`${r.taskId} [${r.runtime}]: Score ${r.overallScore}/100 | Checks ${passed}/${checks.length} | ${r.completionType} | ${r.durationSeconds.toFixed(1)}s | $${r.estimatedCostUsd.toFixed(3)}`);
  }

  if (results.length > 0) {
    const avg = results.reduce((sum, r) => sum + r.overallScore, 0) / results.length;
    console.log(`\nAverage score: ${avg.toFixed(1)}/100`);
  }
}
