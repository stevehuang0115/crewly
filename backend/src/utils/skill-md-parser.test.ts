/**
 * Tests for SKILL.md Parser
 *
 * @module utils/skill-md-parser.test
 */

import { parseSkillMd } from './skill-md-parser.js';

describe('parseSkillMd', () => {
  it('should parse valid SKILL.md with frontmatter and body', () => {
    const content = `---
name: Report Status
description: Notify the orchestrator when a task is done.
version: 1.0.0
category: task-management
skillType: claude-skill
assignableRoles:
  - developer
  - qa
triggers:
  - report status
  - task done
tags:
  - task
  - status
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Report Status

Use this skill to report task completion.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| status | Yes | done, blocked, or failed |
`;

    const result = parseSkillMd(content);

    expect(result.frontmatter.name).toBe('Report Status');
    expect(result.frontmatter.description).toBe('Notify the orchestrator when a task is done.');
    expect(result.frontmatter.version).toBe('1.0.0');
    expect(result.frontmatter.category).toBe('task-management');
    expect(result.frontmatter.skillType).toBe('claude-skill');
    expect(result.frontmatter.assignableRoles).toEqual(['developer', 'qa']);
    expect(result.frontmatter.triggers).toEqual(['report status', 'task done']);
    expect(result.frontmatter.tags).toEqual(['task', 'status']);
    expect(result.frontmatter.execution).toEqual({
      type: 'script',
      script: {
        file: 'execute.sh',
        interpreter: 'bash',
        timeoutMs: 15000,
      },
    });
    expect(result.body).toContain('# Report Status');
    expect(result.body).toContain('## Parameters');
  });

  it('should parse frontmatter-only SKILL.md with empty body', () => {
    const content = `---
name: Simple Skill
description: A simple skill
category: development
---
`;

    const result = parseSkillMd(content);

    expect(result.frontmatter.name).toBe('Simple Skill');
    expect(result.body).toBe('');
  });

  it('should throw on missing opening delimiter', () => {
    const content = `name: Bad
---
Body here`;

    expect(() => parseSkillMd(content)).toThrow('missing opening frontmatter delimiter');
  });

  it('should throw on missing closing delimiter', () => {
    const content = `---
name: Bad
description: No closing`;

    expect(() => parseSkillMd(content)).toThrow('missing closing frontmatter delimiter');
  });

  it('should handle frontmatter with special characters', () => {
    const content = `---
name: "Skill: Special"
description: "Has 'quotes' and [brackets]"
category: development
---

Body content.
`;

    const result = parseSkillMd(content);
    expect(result.frontmatter.name).toBe('Skill: Special');
    expect(result.body).toBe('Body content.');
  });
});
