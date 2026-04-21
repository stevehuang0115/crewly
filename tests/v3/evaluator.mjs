/**
 * V3 Accuracy Diagnostic Evaluator
 * 
 * This script runs the "Golden Set" through the V3 pipeline and evaluates
 * the semantic accuracy of Chat → Request → WorkItem translation.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BACKEND_URL = 'http://localhost:8787';
const FRONTEND_URL = 'http://localhost:8788';
const SCREENSHOT_DIR = '/tmp/v3-eval-screenshots';
const GOLDEN_SET_PATH = './tests/v3/golden-set.json';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiGet(endpoint) {
  try {
    const res = await fetch(`${BACKEND_URL}${endpoint}`);
    return await res.json();
  } catch (err) {
    console.error(`API Get failed: ${endpoint}`, err.message);
    return { data: [] };
  }
}

async function sendMessage(content) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return await res.json();
  } catch (err) {
    console.error(`Send message failed`, err.message);
    return { success: false };
  }
}

/**
 * Heuristic-based Grader (Phase 1 baseline)
 * In Phase 2, this will call an LLM for semantic grading.
 */
function gradeResult(actual, expected) {
  const issues = [];
  let score = 5;

  if (!expected) {
    if (actual.request) {
      issues.push('FAIL: Should NOT have created a Request');
      score = 1;
    }
    return { score, issues };
  }

  if (!actual.request) {
    issues.push('FAIL: Request was not created');
    score = 0;
    return { score, issues };
  }

  // Check title quality
  if (actual.request.title === actual.request.description) {
    issues.push('WARN: Title is a verbatim copy of description (mindless)');
    score -= 1;
  }

  // Check category
  if (actual.request.intentCategory !== expected.expectedRequest.intentCategory) {
    issues.push(`WARN: Category mismatch. Expected ${expected.expectedRequest.intentCategory}, got ${actual.request.intentCategory}`);
    score -= 0.5;
  }

  // Check decomposition
  const actualWorkItemsCount = actual.workItems.length;
  const expectedMinWorkItems = expected.expectedWorkItems?.length || 0;
  
  if (actualWorkItemsCount < expectedMinWorkItems) {
    issues.push(`WARN: Under-decomposed. Expected at least ${expectedMinWorkItems} tasks, got ${actualWorkItemsCount}`);
    score -= 1;
  }

  return { score: Math.max(0, score), issues };
}

async function main() {
  console.log('🚀 Starting V3 Accuracy Diagnostic...\n');

  if (!fs.existsSync(GOLDEN_SET_PATH)) {
    console.error('Golden set file not found!');
    process.exit(1);
  }

  const goldenSet = JSON.parse(fs.readFileSync(GOLDEN_SET_PATH, 'utf-8'));
  const scenarios = goldenSet.scenarios;

  // Launch browser for visual verification
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n---------------------------------------------------------`);
    console.log(`Scenario: ${scenario.id}`);
    console.log(`Input: "${scenario.input}"`);

    // 1. Send message
    const sendResult = await sendMessage(scenario.input);
    if (!sendResult.success) {
      console.log('❌ Failed to send message');
      continue;
    }

    // 2. Wait for processing (correlation window + orchestrator thinking)
    console.log('Waiting 15s for V3 processing...');
    await sleep(15000);

    // 3. Fetch results
    const requestsData = await apiGet('/api/requests');
    const workItemsData = await apiGet('/api/task-pool/all');

    // Find the most recent request matching this scenario
    // (In a real test we should track the exact messageId)
    const latestRequest = (requestsData.data || [])
      .filter(r => r.description.includes(scenario.input.slice(0, 20)))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    const linkedWorkItems = latestRequest 
      ? (workItemsData.data || []).filter(wi => wi.requestId === latestRequest.id)
      : [];

    // 4. Grade
    const actual = latestRequest ? { request: latestRequest, workItems: linkedWorkItems } : { request: null, workItems: [] };
    const grade = gradeResult(actual, scenario.expectedRequest ? scenario : null);

    console.log(`Grade: ${grade.score}/5`);
    if (grade.issues.length > 0) {
      grade.issues.forEach(i => console.log(`  - ${i}`));
    } else {
      console.log('  ✅ Perfectly translated');
    }

    results.push({
      scenario: scenario.id,
      input: scenario.input,
      score: grade.score,
      issues: grade.issues,
      actual: {
        title: latestRequest?.title,
        category: latestRequest?.intentCategory,
        workItemsCount: linkedWorkItems.length
      }
    });
  }

  // 5. Final Report
  console.log(`\n=========================================================`);
  console.log(`Diagnostic Complete`);
  const avgScore = results.reduce((acc, r) => acc + r.score, 0) / results.length;
  console.log(`Average Accuracy Score: ${avgScore.toFixed(2)}/5`);
  
  const reportPath = path.join(SCREENSHOT_DIR, 'v3-accuracy-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    avgScore,
    results
  }, null, 2));
  console.log(`Full report saved to ${reportPath}`);

  await browser.close();
}

main().catch(err => {
  console.error('Evaluator crashed:', err);
  process.exit(1);
});
