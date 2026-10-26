/**
 * Tests for GoalTrackingService
 *
 * Verifies goal setting, focus updates, decision logging, and
 * decision outcome updates against a temporary file system directory.
 *
 * @module services/memory/goal-tracking.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GoalTrackingService, isGoalStatus } from './goal-tracking.service.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

jest.mock('../../constants.js', () => ({
  MEMORY_CONSTANTS: {
    PATHS: {
      GOALS_DIR: 'goals',
      GOALS_FILE: 'goals.md',
      FOCUS_FILE: 'current_focus.md',
      DECISIONS_LOG: 'decisions_log.md',
    },
    GOAL_STATUSES: { ACTIVE: 'active', REACHED: 'reached', SUPERSEDED: 'superseded', CANCELLED: 'cancelled' },
  },
}));

// Use real file-io.utils (they just write files)
jest.mock('../../utils/file-io.utils.js', () => {
  const actual = jest.requireActual('../../utils/file-io.utils.js');
  return {
    ...actual,
    ensureDir: actual.ensureDir,
    atomicWriteFile: actual.atomicWriteFile,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let service: GoalTrackingService;

/**
 * Returns the goals directory for the temp project.
 */
function goalsDir(): string {
  return path.join(tmpDir, '.crewly', 'goals');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  GoalTrackingService.clearInstance();
  service = GoalTrackingService.getInstance();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-tracking-test-'));
});

afterEach(async () => {
  GoalTrackingService.clearInstance();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe('GoalTrackingService singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const a = GoalTrackingService.getInstance();
    const b = GoalTrackingService.getInstance();
    expect(a).toBe(b);
  });

  it('returns a new instance after clearInstance', () => {
    const a = GoalTrackingService.getInstance();
    GoalTrackingService.clearInstance();
    const b = GoalTrackingService.getInstance();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// setGoal / getGoals
// ---------------------------------------------------------------------------

describe('setGoal', () => {
  it('creates goals.md with header on first call', async () => {
    await service.setGoal(tmpDir, 'Ship v2.0');

    const content = await fs.readFile(path.join(goalsDir(), 'goals.md'), 'utf-8');
    expect(content).toContain('# Project Goals');
    expect(content).toContain('Ship v2.0');
    expect(content).toContain('Set by user');
  });

  it('appends additional goals without duplicating header', async () => {
    await service.setGoal(tmpDir, 'Goal one');
    await service.setGoal(tmpDir, 'Goal two', 'orchestrator');

    const content = await fs.readFile(path.join(goalsDir(), 'goals.md'), 'utf-8');
    // Header should only appear once
    const headerCount = (content.match(/# Project Goals/g) || []).length;
    expect(headerCount).toBe(1);

    expect(content).toContain('Goal one');
    expect(content).toContain('Goal two');
    expect(content).toContain('Set by user');
    expect(content).toContain('Set by orchestrator');
  });

  it('includes an ISO timestamp', async () => {
    await service.setGoal(tmpDir, 'Some goal');
    const content = await fs.readFile(path.join(goalsDir(), 'goals.md'), 'utf-8');
    // ISO timestamp pattern: YYYY-MM-DDTHH:MM:SS
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('writes a status word into the heading (a reached goal is a retro milestone, #985) and refuses unknown ones', async () => {
    await service.setGoal(tmpDir, 'Ship v2.0');
    await service.setGoal(tmpDir, 'Ship v2.0\n- shipped 10/25', 'orchestrator', 'reached');
    const content = await fs.readFile(path.join(goalsDir(), 'goals.md'), 'utf-8');
    expect(content).toMatch(/^### \[\d{4}-\d{2}-\d{2}T[^\]]+\] REACHED — Set by orchestrator\nShip v2.0\n- shipped 10\/25$/m);
    // The original entry is untouched (append-only log).
    expect(content).toMatch(/^### \[[^\]]+\] Set by user\nShip v2.0$/m);
    await expect(service.setGoal(tmpDir, 'x', 'user', 'finished')).rejects.toThrow('Unknown goal status "finished"');
    expect(isGoalStatus('Reached')).toBe(true);
    expect(isGoalStatus('finished')).toBe(false);
    expect(isGoalStatus(undefined)).toBe(false);
  });
});

describe('getGoals', () => {
  it('returns null when goals.md does not exist', async () => {
    const result = await service.getGoals(tmpDir);
    expect(result).toBeNull();
  });

  it('returns file content after goals are set', async () => {
    await service.setGoal(tmpDir, 'Test goal');
    const result = await service.getGoals(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('Test goal');
  });
});

// ---------------------------------------------------------------------------
// updateFocus / getCurrentFocus
// ---------------------------------------------------------------------------

describe('updateFocus', () => {
  it('creates current_focus.md with correct structure', async () => {
    await service.updateFocus(tmpDir, 'Auth module work');

    const content = await fs.readFile(path.join(goalsDir(), 'current_focus.md'), 'utf-8');
    expect(content).toContain('# Current Focus');
    expect(content).toContain('**Updated:**');
    expect(content).toContain('**By:** orchestrator');
    expect(content).toContain('Auth module work');
  });

  it('overwrites previous focus', async () => {
    await service.updateFocus(tmpDir, 'First focus');
    await service.updateFocus(tmpDir, 'Second focus', 'user');

    const content = await fs.readFile(path.join(goalsDir(), 'current_focus.md'), 'utf-8');
    expect(content).not.toContain('First focus');
    expect(content).toContain('Second focus');
    expect(content).toContain('**By:** user');
  });
});

describe('getCurrentFocus', () => {
  it('returns null when focus file does not exist', async () => {
    const result = await service.getCurrentFocus(tmpDir);
    expect(result).toBeNull();
  });

  it('returns focus content after update', async () => {
    await service.updateFocus(tmpDir, 'Working on tests');
    const result = await service.getCurrentFocus(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('Working on tests');
  });
});

// ---------------------------------------------------------------------------
// logDecision / getDecisionsLog
// ---------------------------------------------------------------------------

describe('logDecision', () => {
  it('creates decisions_log.md with header on first call', async () => {
    const id = await service.logDecision(tmpDir, {
      title: 'Use PostgreSQL',
      decision: 'PostgreSQL over MongoDB',
      rationale: 'Relational model fits better',
      decidedBy: 'orchestrator',
    });

    expect(id).toMatch(/^dec-\d+-\d+$/);

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    expect(content).toContain('# Decisions Log');
    expect(content).toContain(`[${id}] Use PostgreSQL`);
    expect(content).toContain('**Decision:** PostgreSQL over MongoDB');
    expect(content).toContain('**Rationale:** Relational model fits better');
    expect(content).toContain('**By:** orchestrator');
    expect(content).toContain('**Outcome:** _pending_');
    expect(content).toContain('**Alternatives:** None recorded');
  });

  it('records alternatives when provided', async () => {
    await service.logDecision(tmpDir, {
      title: 'Cache strategy',
      decision: 'Redis',
      rationale: 'Fast',
      decidedBy: 'orchestrator',
      alternatives: ['Memcached', 'In-memory'],
    });

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    expect(content).toContain('**Alternatives:** Memcached, In-memory');
  });

  it('appends multiple decisions', async () => {
    const id1 = await service.logDecision(tmpDir, {
      title: 'Decision A',
      decision: 'A',
      rationale: 'R1',
      decidedBy: 'user',
    });
    const id2 = await service.logDecision(tmpDir, {
      title: 'Decision B',
      decision: 'B',
      rationale: 'R2',
      decidedBy: 'orchestrator',
    });

    expect(id1).not.toBe(id2);

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    expect(content).toContain('Decision A');
    expect(content).toContain('Decision B');

    // Header appears only once
    const headerCount = (content.match(/# Decisions Log/g) || []).length;
    expect(headerCount).toBe(1);
  });
});

describe('getDecisionsLog', () => {
  it('returns null when decisions_log.md does not exist', async () => {
    const result = await service.getDecisionsLog(tmpDir);
    expect(result).toBeNull();
  });

  it('returns content after a decision is logged', async () => {
    await service.logDecision(tmpDir, {
      title: 'Test',
      decision: 'Yes',
      rationale: 'Because',
      decidedBy: 'user',
    });

    const result = await service.getDecisionsLog(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('Test');
  });
});

// ---------------------------------------------------------------------------
// updateDecisionOutcome
// ---------------------------------------------------------------------------

describe('updateDecisionOutcome', () => {
  it('replaces pending outcome with actual outcome', async () => {
    const decId = await service.logDecision(tmpDir, {
      title: 'Use Redis',
      decision: 'Redis for caching',
      rationale: 'Performance',
      decidedBy: 'orchestrator',
    });

    await service.updateDecisionOutcome(tmpDir, decId, 'Successful - 40% latency reduction');

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    expect(content).not.toContain('**Outcome:** _pending_');
    expect(content).toContain('**Outcome:** Successful - 40% latency reduction');
    expect(content).toContain('**Learnings:** None recorded');
    expect(content).toContain('**Recorded:**');
  });

  it('includes learnings when provided', async () => {
    const decId = await service.logDecision(tmpDir, {
      title: 'API versioning',
      decision: 'URL-based versioning',
      rationale: 'Simpler routing',
      decidedBy: 'user',
    });

    await service.updateDecisionOutcome(
      tmpDir,
      decId,
      'Mixed results',
      'Header-based versioning would have been cleaner for internal APIs',
    );

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    expect(content).toContain('**Outcome:** Mixed results');
    expect(content).toContain('**Learnings:** Header-based versioning would have been cleaner for internal APIs');
  });

  it('does not throw when decisions log does not exist', async () => {
    await expect(
      service.updateDecisionOutcome(tmpDir, 'dec-nonexistent', 'Some outcome'),
    ).resolves.toBeUndefined();
  });

  it('does not throw when decision ID is not found', async () => {
    await service.logDecision(tmpDir, {
      title: 'Existing',
      decision: 'D',
      rationale: 'R',
      decidedBy: 'user',
    });

    await expect(
      service.updateDecisionOutcome(tmpDir, 'dec-999999', 'Outcome'),
    ).resolves.toBeUndefined();
  });

  it('does not modify an already-recorded outcome', async () => {
    const decId = await service.logDecision(tmpDir, {
      title: 'Once',
      decision: 'D',
      rationale: 'R',
      decidedBy: 'user',
    });

    await service.updateDecisionOutcome(tmpDir, decId, 'First outcome');
    await service.updateDecisionOutcome(tmpDir, decId, 'Second attempt');

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    // The second call should be a no-op because _pending_ is already replaced
    expect(content).toContain('**Outcome:** First outcome');
    expect(content).not.toContain('Second attempt');
  });

  it('only updates the targeted decision when multiple exist', async () => {
    const id1 = await service.logDecision(tmpDir, {
      title: 'Decision One',
      decision: 'D1',
      rationale: 'R1',
      decidedBy: 'user',
    });
    const id2 = await service.logDecision(tmpDir, {
      title: 'Decision Two',
      decision: 'D2',
      rationale: 'R2',
      decidedBy: 'user',
    });

    await service.updateDecisionOutcome(tmpDir, id1, 'Outcome for D1');

    const content = await fs.readFile(path.join(goalsDir(), 'decisions_log.md'), 'utf-8');
    expect(content).toContain('**Outcome:** Outcome for D1');

    // Second decision should still be pending
    const secondSectionStart = content.indexOf(`[${id2}]`);
    const remainingContent = content.substring(secondSectionStart);
    expect(remainingContent).toContain('**Outcome:** _pending_');
  });
});
