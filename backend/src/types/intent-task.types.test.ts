/**
 * Tests for Intent Task Types — V2
 *
 * Tests classification helpers and the new decomposeIntents function.
 *
 * @module types/intent-task.types.test
 */

import {
  classifyIntentLevel,
  classifyIntentCategory,
  decomposeIntents,
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
// classifyIntentLevel
// =============================================================================

describe('classifyIntentLevel', () => {
  it('should classify simple questions as L0', () => {
    expect(classifyIntentLevel('What time is it?')).toBe('L0');
    expect(classifyIntentLevel('Show me the status')).toBe('L0');
    expect(classifyIntentLevel('How many agents are active?')).toBe('L0');
    expect(classifyIntentLevel('Is the server running?')).toBe('L0');
  });

  it('should classify complex multi-step tasks as L2', () => {
    expect(classifyIntentLevel('Implement a new authentication feature for the web service')).toBe('L2');
    expect(classifyIntentLevel('Build the user registration system with email verification')).toBe('L2');
    expect(classifyIntentLevel('Deploy the staging environment')).toBe('L2');
    expect(classifyIntentLevel('Coordinate the team to deliver the sprint tasks')).toBe('L2');
  });

  it('should classify standard tasks as L1', () => {
    expect(classifyIntentLevel('Fix the login bug')).toBe('L1');
    expect(classifyIntentLevel('Run the test suite')).toBe('L1');
    expect(classifyIntentLevel('Update the README')).toBe('L1');
  });

  it('should classify very long intents as L2', () => {
    const longIntent = Array(35).fill('word').join(' ');
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
  });

  it('should classify deployment intents', () => {
    expect(classifyIntentCategory('Deploy to staging')).toBe('deployment');
    expect(classifyIntentCategory('Release version 2.0')).toBe('deployment');
    expect(classifyIntentCategory('Update the Docker configuration')).toBe('deployment');
  });

  it('should classify code_change intents', () => {
    expect(classifyIntentCategory('Implement the search feature')).toBe('code_change');
    expect(classifyIntentCategory('Add a new endpoint for users')).toBe('code_change');
    expect(classifyIntentCategory('Refactor the auth module')).toBe('code_change');
  });

  it('should classify review intents', () => {
    expect(classifyIntentCategory('Review the PR for login')).toBe('review');
    expect(classifyIntentCategory('Audit the security config')).toBe('review');
  });

  it('should classify research intents', () => {
    expect(classifyIntentCategory('Research the best auth library')).toBe('research');
    expect(classifyIntentCategory('Investigate the best framework options')).toBe('research');
  });

  it('should classify planning intents', () => {
    expect(classifyIntentCategory('Plan the sprint tasks')).toBe('planning');
    expect(classifyIntentCategory('Design the API architecture')).toBe('planning');
  });

  it('should classify communication intents', () => {
    expect(classifyIntentCategory('Message the team about lunch')).toBe('communication');
    expect(classifyIntentCategory('Notify on Slack about the meeting')).toBe('communication');
  });

  it('should classify query intents', () => {
    expect(classifyIntentCategory('What is the current status?')).toBe('query');
    expect(classifyIntentCategory('Show me active agents')).toBe('query');
  });

  it('should return other for unrecognizable intents', () => {
    expect(classifyIntentCategory('lorem ipsum dolor')).toBe('other');
  });
});

// =============================================================================
// decomposeIntents
// =============================================================================

describe('decomposeIntents', () => {
  it('should decompose a message with "then" into multiple intents', () => {
    const result = decomposeIntents('Search for abc then make it into a PDF');
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0].intent).toBe('Search for abc');
    expect(result.intents[1].intent).toBe('make it into a PDF');
  });

  it('should decompose a message with "and also"', () => {
    const result = decomposeIntents('Fix the login bug and also update the README');
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0].intent).toBe('Fix the login bug');
    expect(result.intents[1].intent).toBe('update the README');
  });

  it('should decompose a message with "and" followed by an action verb', () => {
    const result = decomposeIntents('Check the logs and fix the error');
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0].intent).toBe('Check the logs');
    expect(result.intents[1].intent).toBe('fix the error');
  });

  it('should decompose a message with "after that"', () => {
    const result = decomposeIntents('Run the tests after that deploy to staging');
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0].intent).toBe('Run the tests');
    expect(result.intents[1].intent).toBe('deploy to staging');
  });

  it('should decompose a message with "plus"', () => {
    const result = decomposeIntents('Write unit tests plus add integration tests');
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0].intent).toBe('Write unit tests');
    expect(result.intents[1].intent).toBe('add integration tests');
  });

  it('should treat a single intent message as one task', () => {
    const result = decomposeIntents('Fix the login bug');
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].intent).toBe('Fix the login bug');
  });

  it('should classify each decomposed intent independently', () => {
    const result = decomposeIntents('What time is it? then deploy to staging');
    expect(result.intents).toHaveLength(2);
    // First is a question — classified per its own content
    expect(result.intents[0].category).toBe('query');
    expect(result.intents[1].category).toBe('deployment');
  });

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

  it('should filter out very short segments', () => {
    // "x then y" — "x" is too short (< 3 chars) after trim
    const result = decomposeIntents('x then do something useful');
    // "x" is filtered out (length < 3), only "do something useful" remains
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].intent).toBe('do something useful');
  });

  it('should handle three-way decomposition', () => {
    const result = decomposeIntents('Search for files then fix the bug and also deploy');
    expect(result.intents.length).toBeGreaterThanOrEqual(2);
    // At least "Search for files", "fix the bug", "deploy" — exact count depends on pattern order
  });

  it('should decompose comma-separated action verbs', () => {
    const result = decomposeIntents('Review the PR, update the docs, and send a notification');
    expect(result.intents.length).toBeGreaterThanOrEqual(2);
  });

  it('should set messageId to empty string (service generates UUID)', () => {
    const result = decomposeIntents('Fix something');
    expect(result.messageId).toBe('');
  });

  it('should classify levels per decomposed intent', () => {
    const result = decomposeIntents('What time is it? then implement a new authentication feature for the web service');
    expect(result.intents.length).toBe(2);
    // First: short question -> L0
    expect(result.intents[0].level).toBe('L0');
    // Second: complex implementation -> L2
    expect(result.intents[1].level).toBe('L2');
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
