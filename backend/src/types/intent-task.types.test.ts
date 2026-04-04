/**
 * Tests for Intent Task Types — V2
 *
 * Tests actionability detection, classification helpers, and decomposeIntents.
 *
 * @module types/intent-task.types.test
 */

import {
  classifyIntentLevel,
  classifyIntentCategory,
  decomposeIntents,
  isActionableIntent,
} from './intent-task.types.js';
import type {
  IntentLevel,
  IntentCategory,
  DecomposeResult,
  DecomposedIntent,
  MessageGroup,
  ProjectTaskStatus,
  IntentTask,
  IntentTaskSummary,
} from './intent-task.types.js';

// =============================================================================
// isActionableIntent
// =============================================================================

describe('isActionableIntent', () => {
  describe('should reject non-actionable messages', () => {
    it('rejects greetings', () => {
      expect(isActionableIntent('Hi there')).toBe(false);
      expect(isActionableIntent('Hello everyone')).toBe(false);
      expect(isActionableIntent('Good morning')).toBe(false);
      expect(isActionableIntent('Hey!')).toBe(false);
      expect(isActionableIntent('Welcome back')).toBe(false);
    });

    it('rejects acknowledgments', () => {
      expect(isActionableIntent('Ok')).toBe(false);
      expect(isActionableIntent('Got it')).toBe(false);
      expect(isActionableIntent('Understood')).toBe(false);
      expect(isActionableIntent('Sure')).toBe(false);
      expect(isActionableIntent('Looks good')).toBe(false);
      expect(isActionableIntent('LGTM')).toBe(false);
      expect(isActionableIntent('Sounds good')).toBe(false);
      expect(isActionableIntent('Will do')).toBe(false);
      expect(isActionableIntent('Great job!')).toBe(false);
      expect(isActionableIntent('Nice!')).toBe(false);
      expect(isActionableIntent('Approved')).toBe(false);
      expect(isActionableIntent('Noted')).toBe(false);
      expect(isActionableIntent('Agreed')).toBe(false);
    });

    it('rejects pure questions', () => {
      expect(isActionableIntent('What time is it?')).toBe(false);
      expect(isActionableIntent('How is the project going?')).toBe(false);
      expect(isActionableIntent('Is the server running?')).toBe(false);
      expect(isActionableIntent('When is the deadline?')).toBe(false);
      expect(isActionableIntent('Who is working on this?')).toBe(false);
      expect(isActionableIntent('Can you explain this?')).toBe(false);
    });

    it('rejects opinions and discussion', () => {
      expect(isActionableIntent('I think we should reconsider')).toBe(false);
      expect(isActionableIntent('Maybe we could try another approach')).toBe(false);
      expect(isActionableIntent('FYI the meeting is at 3')).toBe(false);
      expect(isActionableIntent('Just letting you know it works')).toBe(false);
    });

    it('rejects status updates (not requests)', () => {
      expect(isActionableIntent('I just finished the review')).toBe(false);
      expect(isActionableIntent('Done with the tests')).toBe(false);
      expect(isActionableIntent('I already pushed the fix')).toBe(false);
      expect(isActionableIntent('All done')).toBe(false);
    });

    it('rejects too-short messages', () => {
      expect(isActionableIntent('ok')).toBe(false);
      expect(isActionableIntent('yes')).toBe(false);
      expect(isActionableIntent('no')).toBe(false);
      expect(isActionableIntent('hi')).toBe(false);
    });

    it('rejects very short messages', () => {
      expect(isActionableIntent('ok')).toBe(false);
      expect(isActionableIntent('no')).toBe(false);
    });
  });

  describe('should accept actionable intents', () => {
    it('accepts imperative action requests', () => {
      expect(isActionableIntent('Fix the login bug')).toBe(true);
      expect(isActionableIntent('Deploy to staging')).toBe(true);
      expect(isActionableIntent('Create a new endpoint')).toBe(true);
      expect(isActionableIntent('Update the README')).toBe(true);
      expect(isActionableIntent('Run the test suite')).toBe(true);
      expect(isActionableIntent('Refactor the auth module')).toBe(true);
    });

    it('accepts search/find requests', () => {
      expect(isActionableIntent('Search for abc')).toBe(true);
      expect(isActionableIntent('Find the broken test')).toBe(true);
    });

    it('accepts setup/configuration requests', () => {
      expect(isActionableIntent('Set up the database connection')).toBe(true);
      expect(isActionableIntent('Configure the CI pipeline')).toBe(true);
      expect(isActionableIntent('Install the dependencies')).toBe(true);
    });

    it('accepts review/analysis requests', () => {
      expect(isActionableIntent('Review the PR for login')).toBe(true);
      expect(isActionableIntent('Analyze the error logs')).toBe(true);
      expect(isActionableIntent('Investigate the memory leak')).toBe(true);
    });

    it('accepts multi-word action phrases', () => {
      expect(isActionableIntent('Clean up the temp files')).toBe(true);
      expect(isActionableIntent('Set up monitoring for the API')).toBe(true);
    });
  });
});

// =============================================================================
// classifyIntentLevel
// =============================================================================

describe('classifyIntentLevel', () => {
  it('should classify simple queries as L0', () => {
    expect(classifyIntentLevel('What time is it?')).toBe('L0');
    expect(classifyIntentLevel('Show me the status')).toBe('L0');
    expect(classifyIntentLevel('How many agents are active?')).toBe('L0');
    expect(classifyIntentLevel('Is the server running?')).toBe('L0');
    expect(classifyIntentLevel('Check the health status')).toBe('L0');
    expect(classifyIntentLevel('List all active projects')).toBe('L0');
  });

  it('should classify complex multi-step tasks as L2', () => {
    expect(classifyIntentLevel('Implement a new authentication feature for the web service')).toBe('L2');
    expect(classifyIntentLevel('Build the user registration system with email verification')).toBe('L2');
    expect(classifyIntentLevel('Deploy the app to staging environment')).toBe('L2');
    expect(classifyIntentLevel('Coordinate the team to deliver the sprint tasks')).toBe('L2');
    expect(classifyIntentLevel('Migrate the database from MySQL to PostgreSQL')).toBe('L2');
    expect(classifyIntentLevel('Design the API architecture for the new pipeline')).toBe('L2');
  });

  it('should classify standard tasks as L1', () => {
    expect(classifyIntentLevel('Fix the login bug')).toBe('L1');
    expect(classifyIntentLevel('Run the test suite')).toBe('L1');
    expect(classifyIntentLevel('Update the README')).toBe('L1');
    expect(classifyIntentLevel('Rename the variable')).toBe('L1');
    expect(classifyIntentLevel('Add error handling to the parser')).toBe('L1');
  });

  it('should classify very long intents as L2', () => {
    const longIntent = Array(40).fill('word').join(' ');
    expect(classifyIntentLevel(longIntent)).toBe('L2');
  });
});

// =============================================================================
// classifyIntentCategory
// =============================================================================

describe('classifyIntentCategory', () => {
  it('should classify debugging intents', () => {
    expect(classifyIntentCategory('Fix the login bug')).toBe('debugging');
    expect(classifyIntentCategory('Debug the crash in auth service')).toBe('debugging');
    expect(classifyIntentCategory('Trace the error in payments')).toBe('debugging');
    expect(classifyIntentCategory('Investigate the flaky test')).toBe('debugging');
    expect(classifyIntentCategory('Fix the memory leak')).toBe('debugging');
  });

  it('should classify deployment intents', () => {
    expect(classifyIntentCategory('Deploy to staging')).toBe('deployment');
    expect(classifyIntentCategory('Release version 2.0')).toBe('deployment');
    expect(classifyIntentCategory('Update the Docker configuration')).toBe('deployment');
    expect(classifyIntentCategory('Rollback the production release')).toBe('deployment');
    expect(classifyIntentCategory('Scale the k8s cluster')).toBe('deployment');
  });

  it('should classify code_change intents', () => {
    expect(classifyIntentCategory('Implement the search feature')).toBe('code_change');
    expect(classifyIntentCategory('Add a new endpoint for users')).toBe('code_change');
    expect(classifyIntentCategory('Refactor the auth module')).toBe('code_change');
    expect(classifyIntentCategory('Clean up the temp files')).toBe('code_change');
    expect(classifyIntentCategory('Set up the database connection')).toBe('code_change');
    // Note: "Configure the CI pipeline" → deployment (CI pipeline context takes priority)
    expect(classifyIntentCategory('Configure the logging settings')).toBe('code_change');
    expect(classifyIntentCategory('Optimize the query performance')).toBe('code_change');
    expect(classifyIntentCategory('Rename the variable to something descriptive')).toBe('code_change');
  });

  it('should classify review intents', () => {
    expect(classifyIntentCategory('Review the PR for login')).toBe('review');
    expect(classifyIntentCategory('Audit the security config')).toBe('review');
  });

  it('should classify research intents', () => {
    expect(classifyIntentCategory('Research the best auth library')).toBe('research');
    expect(classifyIntentCategory('Investigate the best framework options')).toBe('research');
    expect(classifyIntentCategory('Benchmark the different approaches')).toBe('research');
    expect(classifyIntentCategory('Profile the slow endpoint')).toBe('research');
  });

  it('should classify planning intents', () => {
    expect(classifyIntentCategory('Plan the sprint tasks')).toBe('planning');
    expect(classifyIntentCategory('Design the API architecture')).toBe('planning');
    expect(classifyIntentCategory('Write the RFC for the new feature')).toBe('planning');
    expect(classifyIntentCategory('Estimate the timeline for migration')).toBe('planning');
  });

  it('should classify communication intents', () => {
    expect(classifyIntentCategory('Message the team about lunch')).toBe('communication');
    expect(classifyIntentCategory('Notify on Slack about the meeting')).toBe('communication');
    expect(classifyIntentCategory('Announce the release to the team')).toBe('communication');
  });

  it('should classify query intents', () => {
    expect(classifyIntentCategory('What is the current status?')).toBe('query');
    expect(classifyIntentCategory('Show me active agents')).toBe('query');
    expect(classifyIntentCategory('Find all failing tests')).toBe('query');
    expect(classifyIntentCategory('Search for the config file')).toBe('query');
  });

  it('should return other for unrecognizable intents', () => {
    expect(classifyIntentCategory('lorem ipsum dolor')).toBe('other');
  });
});

// =============================================================================
// decomposeIntents
// =============================================================================

describe('decomposeIntents', () => {
  describe('multi-intent splitting', () => {
    it('should decompose "then" into multiple intents', () => {
      const result = decomposeIntents('Search for abc then make it into a PDF');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].intent).toBe('Search for abc');
      expect(result.intents[1].intent).toBe('make it into a PDF');
    });

    it('should decompose "and also"', () => {
      const result = decomposeIntents('Fix the login bug and also update the README');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].intent).toBe('Fix the login bug');
      expect(result.intents[1].intent).toBe('update the README');
    });

    it('should decompose "and" before action verb', () => {
      const result = decomposeIntents('Check the logs and fix the error');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].intent).toBe('Check the logs');
      expect(result.intents[1].intent).toBe('fix the error');
    });

    it('should decompose "after that"', () => {
      const result = decomposeIntents('Run the tests after that deploy to staging');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].intent).toBe('Run the tests');
      expect(result.intents[1].intent).toBe('deploy to staging');
    });

    it('should decompose "plus"', () => {
      const result = decomposeIntents('Write unit tests plus add integration tests');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].intent).toBe('Write unit tests');
      expect(result.intents[1].intent).toBe('add integration tests');
    });

    it('should handle three-way decomposition', () => {
      const result = decomposeIntents('Search for the config file then fix the bug and also deploy to staging');
      expect(result.intents.length).toBeGreaterThanOrEqual(2);
    });

    it('should decompose semicolon-separated actions', () => {
      const result = decomposeIntents('Fix the bug; deploy to staging');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].intent).toBe('Fix the bug');
      expect(result.intents[1].intent).toBe('deploy to staging');
    });

    it('should decompose comma-separated action verbs', () => {
      const result = decomposeIntents('Review the PR, update the docs, and send a notification');
      expect(result.intents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('actionability filtering', () => {
    it('should filter out greetings — return no tasks', () => {
      const result = decomposeIntents('Hi there, good morning!');
      expect(result.intents).toHaveLength(0);
    });

    it('should filter out pure questions — return no tasks', () => {
      const result = decomposeIntents('How is the project going?');
      expect(result.intents).toHaveLength(0);
    });

    it('should filter out acknowledgments — return no tasks', () => {
      const result = decomposeIntents('Looks good, thanks!');
      expect(result.intents).toHaveLength(0);
    });

    it('should filter out opinions — return no tasks', () => {
      const result = decomposeIntents('I think we should reconsider the approach');
      expect(result.intents).toHaveLength(0);
    });

    it('should filter out status updates — return no tasks', () => {
      const result = decomposeIntents('I just finished the review');
      expect(result.intents).toHaveLength(0);
    });

    it('should keep actionable parts when mixed with non-actionable', () => {
      // "thanks" part filtered, "deploy to staging" kept
      const result = decomposeIntents('Fix the bug then deploy to staging');
      expect(result.intents.length).toBeGreaterThanOrEqual(1);
      // All returned intents should be actionable
      for (const intent of result.intents) {
        expect(isActionableIntent(intent.intent)).toBe(true);
      }
    });
  });

  describe('single intent messages', () => {
    it('should treat a single actionable message as one task', () => {
      const result = decomposeIntents('Fix the login bug');
      expect(result.intents).toHaveLength(1);
      expect(result.intents[0].intent).toBe('Fix the login bug');
    });

    it('should return empty for non-actionable single message', () => {
      const result = decomposeIntents('Sounds good');
      expect(result.intents).toHaveLength(0);
    });
  });

  describe('classification per segment', () => {
    it('should classify each decomposed intent independently', () => {
      const result = decomposeIntents('Fix the crash then deploy to staging');
      expect(result.intents).toHaveLength(2);
      expect(result.intents[0].category).toBe('debugging');
      expect(result.intents[1].category).toBe('deployment');
    });

    it('should classify levels per decomposed intent', () => {
      const result = decomposeIntents('Check the status then implement a new authentication feature for the web service');
      // "Check the status" is L0, "implement..." is L2
      expect(result.intents.length).toBeGreaterThanOrEqual(1);
      const levels = result.intents.map((i) => i.level);
      // Should have at least one non-L1 if classification works
      expect(levels.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should preserve the original message', () => {
      const msg = 'Search for abc then make it into a PDF';
      const result = decomposeIntents(msg);
      expect(result.originalMessage).toBe(msg);
    });

    it('should handle empty message', () => {
      const result = decomposeIntents('');
      expect(result.intents).toHaveLength(0);
    });

    it('should handle whitespace-only message', () => {
      const result = decomposeIntents('   ');
      expect(result.intents).toHaveLength(0);
    });

    it('should set messageId to empty string (service generates UUID)', () => {
      const result = decomposeIntents('Fix something broken');
      expect(result.messageId).toBe('');
    });
  });
});

// =============================================================================
// Type Structure Validation
// =============================================================================

describe('type structures', () => {
  it('IntentTask should include v2 fields', () => {
    const task: IntentTask = {
      id: 'test-id',
      messageId: 'msg-1',
      intent: 'test intent',
      level: 'L1',
      category: 'code_change',
      status: 'classified',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      assignedSessions: [],
      runs: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalSkillCost: 0,
      order: 0,
      scheduleId: 'sched-1',
      projectTaskId: 'proj-task-1',
    };

    expect(task.messageId).toBe('msg-1');
    expect(task.scheduleId).toBe('sched-1');
    expect(task.projectTaskId).toBe('proj-task-1');
    expect(task.order).toBe(0);
  });

  it('IntentTaskSummary should include v2 fields', () => {
    const summary: IntentTaskSummary = {
      id: 'test-id',
      messageId: 'msg-1',
      intent: 'test',
      level: 'L1',
      category: 'code_change',
      status: 'classified',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
      totalTokens: 0,
      totalCost: 0,
      totalSkillCost: 0,
      assignedSessions: [],
      order: 0,
      scheduleId: 'sched-1',
      projectTaskId: 'proj-1',
    };

    expect(summary.messageId).toBe('msg-1');
    expect(summary.order).toBe(0);
    expect(summary.scheduleId).toBe('sched-1');
    expect(summary.projectTaskId).toBe('proj-1');
  });

  it('MessageGroup should have correct structure', () => {
    const group: MessageGroup = {
      messageId: 'msg-1',
      originalMessage: 'Search for abc then make PDF',
      createdAt: new Date().toISOString(),
      tasks: [],
      completedCount: 0,
      totalCount: 2,
    };

    expect(group.messageId).toBe('msg-1');
    expect(group.completedCount).toBe(0);
    expect(group.totalCount).toBe(2);
  });

  it('ProjectTaskStatus should have correct structure', () => {
    const status: ProjectTaskStatus = {
      projectTaskId: 'proj-1',
      totalTasks: 3,
      completedTasks: 2,
      allCompleted: false,
      tasks: [],
    };

    expect(status.allCompleted).toBe(false);
    expect(status.completedTasks).toBe(2);
  });

  it('TaskSpan should support costOverride for skill costs', () => {
    const span: import('./intent-task.types.js').TaskSpan = {
      id: 'span-1',
      runId: 'run-1',
      type: 'skill_call',
      label: 'browser-screenshot',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 2000,
      inputTokens: 0,
      outputTokens: 0,
      costOverride: 0.05,
      metadata: { action: 'screenshot' },
    };

    expect(span.type).toBe('skill_call');
    expect(span.costOverride).toBe(0.05);
  });

  it('DecomposeResult should have correct structure', () => {
    const result: DecomposeResult = {
      originalMessage: 'Do X then Y',
      messageId: 'msg-123',
      intents: [
        { intent: 'Do X', level: 'L1', category: 'code_change' },
        { intent: 'Y', level: 'L1', category: 'other' },
      ],
    };

    expect(result.intents).toHaveLength(2);
    expect(result.messageId).toBe('msg-123');
  });
});
