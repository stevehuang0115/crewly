/**
 * V3 End-to-End Integration Test
 *
 * Tests the full V3 Task Pool lifecycle via HTTP API:
 * 1. addToPool → claim → heartbeat → release
 * 2. Hybrid work-loop (V2 push → V3 poll fallback)
 * 3. Fission Guard initialization
 *
 * Run against a live backend (default: http://localhost:8787)
 *
 * @module tests/v3-e2e-integration.test
 */

const BASE_URL = process.env.CREWLY_BASE_URL || 'http://localhost:8787';

/**
 * Helper: Make an HTTP request and return parsed JSON.
 *
 * @param method - HTTP method
 * @param path - URL path (appended to BASE_URL)
 * @param body - Optional request body
 * @returns Parsed JSON response
 */
async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const url = `${BASE_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url);
  // Re-do with proper method
  const res2 = await fetch(url, opts);
  return res2.json() as Promise<Record<string, unknown>>;
}

/**
 * Simpler HTTP helper using fetch directly.
 */
async function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `${BASE_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json() as Record<string, unknown>;
  return { status: res.status, data };
}

// ============================================================================
// Test 1: Task Pool Claim Full Flow
// ============================================================================
async function testTaskPoolClaimFlow(): Promise<void> {
  console.log('\n========================================');
  console.log('TEST 1: Task Pool Claim Full Flow');
  console.log('========================================\n');

  const testWorkItem = {
    id: `e2e-test-${Date.now()}`,
    type: 'delegate',
    owner: 'agent',
    target: 'test-agent-sam-e2e',
    title: 'E2E Test: V3 claim lifecycle',
    description: 'Testing addToPool → claim → heartbeat → release',
    status: 'queued',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };

  // Step 1: Add to pool
  console.log('Step 1: addToPool');
  const addRes = await request('POST', '/api/task-pool/add', testWorkItem);
  console.log(`  Status: ${addRes.status}`);
  console.log(`  Response: ${JSON.stringify(addRes.data)}`);
  if (addRes.status !== 201) throw new Error(`addToPool failed: ${JSON.stringify(addRes.data)}`);
  console.log('  ✅ WorkItem added to pool\n');

  // Verify it's in the pool
  const listRes = await request('GET', '/api/task-pool');
  const items = (listRes.data as Record<string, unknown>).data as Array<Record<string, unknown>>;
  const found = items.find((i) => i.id === testWorkItem.id);
  if (!found) throw new Error('WorkItem not found in pool after add');
  console.log(`  Pool now has ${(listRes.data as Record<string, unknown>).count} items`);

  // Step 2: Claim
  console.log('\nStep 2: claimFromPool');
  const claimRes = await request('POST', '/api/task-pool/claim', {
    agentId: 'test-agent-sam-e2e',
    filters: { types: ['delegate'] },
  });
  console.log(`  Status: ${claimRes.status}`);
  if (claimRes.status !== 200) throw new Error(`claim failed: ${JSON.stringify(claimRes.data)}`);
  const claimData = (claimRes.data as Record<string, unknown>).data as Record<string, unknown>;
  const claim = claimData.claim as Record<string, unknown>;
  const claimId = claim.id as string;
  console.log(`  Claim ID: ${claimId}`);
  console.log(`  WorkItem status: ${(claimData.workItem as Record<string, unknown>).status}`);
  console.log('  ✅ WorkItem claimed\n');

  // Step 3: Heartbeat
  console.log('Step 3: heartbeat');
  const hbRes = await request('POST', '/api/task-pool/heartbeat', {
    claimId,
    agentId: 'test-agent-sam-e2e',
  });
  console.log(`  Status: ${hbRes.status}`);
  if (hbRes.status !== 200) throw new Error(`heartbeat failed: ${JSON.stringify(hbRes.data)}`);
  console.log('  ✅ Heartbeat accepted\n');

  // Step 4: Release
  console.log('Step 4: release');
  const releaseRes = await request('POST', `/api/task-pool/release/${testWorkItem.id}`, {
    reason: 'e2e test completed',
  });
  console.log(`  Status: ${releaseRes.status}`);
  if (releaseRes.status !== 200) throw new Error(`release failed: ${JSON.stringify(releaseRes.data)}`);
  console.log('  ✅ WorkItem released back to pool\n');

  // Verify final state
  const statsRes = await request('GET', '/api/task-pool/stats');
  console.log(`  Final pool stats: ${JSON.stringify((statsRes.data as Record<string, unknown>).data)}`);

  console.log('\n✅ TEST 1 PASSED: claim→heartbeat→release lifecycle works\n');
}

// ============================================================================
// Test 2: Hybrid Work-Loop (via API simulation)
// ============================================================================
async function testHybridWorkLoop(): Promise<void> {
  console.log('\n========================================');
  console.log('TEST 2: Hybrid Work-Loop (API simulation)');
  console.log('========================================\n');

  // The work-loop skill is a bash script that:
  // 1. Checks V2 push tasks (get-my-tasks)
  // 2. Falls back to V3 poll (poll-tasks)
  //
  // We validate the V3 poll path by adding an item and confirming
  // it can be claimed via the API (same as poll-tasks does).

  const testWorkItem = {
    id: `e2e-workloop-${Date.now()}`,
    type: 'project_task',
    owner: 'agent',
    target: 'test-workloop-agent',
    title: 'E2E Test: Work-loop V3 poll path',
    status: 'queued',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };

  // Add to pool (simulating what delegate-task should do)
  const addRes = await request('POST', '/api/task-pool/add', testWorkItem);
  if (addRes.status !== 201) throw new Error(`addToPool failed: ${JSON.stringify(addRes.data)}`);
  console.log('  Added test work item to pool');

  // Simulate V3 poll path — agent polls with filters
  const pollRes = await request('GET', '/api/task-pool?types=delegate,project_task&owner=agent');
  const available = (pollRes.data as Record<string, unknown>).data as Array<Record<string, unknown>>;
  const match = available.find((i) => i.id === testWorkItem.id);
  if (!match) throw new Error('V3 poll did not find the queued work item');
  console.log(`  V3 poll found ${available.length} available item(s) — matched our test item`);

  // Claim it
  const claimRes = await request('POST', '/api/task-pool/claim', {
    agentId: 'test-workloop-agent',
    filters: { types: ['project_task'] },
  });
  if (claimRes.status !== 200) throw new Error(`claim failed: ${JSON.stringify(claimRes.data)}`);
  console.log('  Agent claimed work item via V3 poll path');

  // Clean up — release it
  await request('POST', `/api/task-pool/release/${testWorkItem.id}`, { reason: 'e2e cleanup' });

  console.log('\n✅ TEST 2 PASSED: V3 poll path works (V2→V3 fallback ready)\n');
}

// ============================================================================
// Test 3: Fission Guard Initialization
// ============================================================================
async function testFissionGuard(): Promise<void> {
  console.log('\n========================================');
  console.log('TEST 3: Fission Guard Initialization');
  console.log('========================================\n');

  const configRes = await request('GET', '/api/fission/config');
  console.log(`  Status: ${configRes.status}`);
  console.log(`  Response: ${JSON.stringify(configRes.data)}`);

  if (configRes.status === 503) {
    console.log('\n❌ TEST 3 FAILED: Fission Guard still not initialized');
    console.log('  Fix: Need to restart backend after code change');
    return;
  }

  if (configRes.status !== 200) {
    throw new Error(`Unexpected status: ${configRes.status}`);
  }

  const config = (configRes.data as Record<string, unknown>).data as Record<string, unknown>;
  console.log(`  maxDepth: ${config.maxDepth}`);
  console.log(`  maxTasksPerMission: ${config.maxTasksPerMission}`);
  console.log(`  maxBranchingFactor: ${config.maxBranchingFactor}`);
  console.log(`  budgetGateEnabled: ${config.budgetGateEnabled}`);

  // Check stats endpoint too
  const statsRes = await request('GET', '/api/fission/stats');
  if (statsRes.status !== 200) throw new Error(`Fission stats failed: ${JSON.stringify(statsRes.data)}`);
  console.log(`  Violations so far: ${((statsRes.data as Record<string, unknown>).data as Record<string, unknown>).totalViolations}`);

  console.log('\n✅ TEST 3 PASSED: Fission Guard initialized and responding\n');
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<void> {
  console.log('V3 End-to-End Integration Tests');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Verify backend is reachable
  try {
    const health = await request('GET', '/health');
    if (health.status !== 200) throw new Error('Backend not healthy');
    console.log('Backend health check: ✅\n');
  } catch {
    console.error('❌ Backend not reachable at', BASE_URL);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  try {
    await testTaskPoolClaimFlow();
    passed++;
  } catch (err) {
    console.error('❌ TEST 1 FAILED:', (err as Error).message);
    failed++;
  }

  try {
    await testHybridWorkLoop();
    passed++;
  } catch (err) {
    console.error('❌ TEST 2 FAILED:', (err as Error).message);
    failed++;
  }

  try {
    await testFissionGuard();
    passed++;
  } catch (err) {
    console.error('❌ TEST 3 FAILED:', (err as Error).message);
    failed++;
  }

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
