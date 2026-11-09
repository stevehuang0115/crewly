---
id: qa-testing-procedures
version: 1
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-01-29T00:00:00Z
createdBy: system
role: qa
category: testing
priority: 10
title: Testing Procedures
description: Standard testing procedures for QA agents
triggers:
  - test
  - verify
  - validate
  - qa
  - quality
tags:
  - testing
  - quality
  - qa
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded — part of the original default SOP library (2026-01-29); re-test before keeping"
seenOn: "unknown"
reviewBy: 2026-12-31
source: https://github.com/stevehuang0115/crewly/commit/77d504515
---

# Testing Procedures

## Review Process

1. **Read requirements** - Understand acceptance criteria
2. **Review code** - Check implementation approach
3. **Run automated tests** - Verify tests pass
4. **Manual testing** - Test edge cases
5. **Document findings** - Report issues clearly

## Test Cases

For each feature, verify:
- Happy path works
- Error cases handled
- Edge cases covered
- Performance acceptable
- Security considered

## Bug Reporting

Include:
- Clear title
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots/logs
- Environment details

## Quality Gates

Before approving:
- [ ] All acceptance criteria met
- [ ] Tests pass
- [ ] No critical bugs
- [ ] Code reviewed
- [ ] Documentation updated
