# Quality Gates

**Trigger**: before_deploy
**Applies to**: *
**Version**: 1.0.0

## Overview

Before any code is deployed (to staging or production), all quality gates must pass.
No exceptions. These gates are enforced automatically via the verification pipeline
and manually verified by the team leader.

## Steps

1. **TypeScript Compilation**
   - Run: `npm run build`
   - Requirement: Zero errors, zero warnings
   - Covers: All components (backend, frontend, CLI, MCP server)

2. **Type Checking**
   - Run: `npm run typecheck` (or `npx tsc --noEmit`)
   - Requirement: No type errors in any source file
   - Strict mode must be enabled

3. **Unit Tests**
   - Run: `npm test`
   - Requirement: 100% pass rate
   - Minimum 80% code coverage for new code

4. **Linting**
   - Run: `npm run lint`
   - Requirement: No errors (warnings acceptable with justification)

5. **Integration Verification**
   - Backend health: `curl http://localhost:3000/health` returns 200
   - MCP server health: `curl http://localhost:3001/health` returns 200
   - CLI smoke test: `npx crewly start --no-browser` starts without errors

6. **Code Quality**
   - No `console.log` in production code
   - No commented-out code blocks
   - No TODO comments without linked GitHub issues
   - All functions have JSDoc documentation

## Checklist

- [ ] `npm run build` — zero errors
- [ ] `npm run typecheck` — zero type errors
- [ ] `npm test` — 100% pass rate
- [ ] `npm run lint` — no errors
- [ ] Backend health check passes
- [ ] MCP server health check passes
- [ ] No console.log in production code
- [ ] No commented-out code
- [ ] All new functions have JSDoc

## Exceptions

- **Staging-only deploys** for testing may proceed with lint warnings if time-critical,
  but must be cleaned up before production deploy.
- **Emergency hotfixes** must still pass Steps 1-4 (build, typecheck, tests, lint).
  Steps 5-6 can be verified post-deploy.
