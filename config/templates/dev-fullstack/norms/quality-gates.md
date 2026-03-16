# Quality Gates

**Trigger**: before_deploy
**Applies to**: *
**Version**: 1.0.0

## Overview

Mandatory quality checks that must pass before any deployment. These gates ensure that code is type-safe, well-tested, lint-clean, and builds successfully. No deployment is permitted until all gates are green.

## Steps

### Step 1: TypeScript Strict Mode Verification

```bash
npm run typecheck
```

- TypeScript strict mode must be enabled
- Zero type errors allowed
- No `any` types in new or modified code
- All function parameters and return types must be explicitly typed

### Step 2: Lint Check

```bash
npm run lint
```

- All ESLint rules must pass
- No warnings treated as errors
- No `eslint-disable` comments without justification
- Import ordering must follow project conventions

### Step 3: Unit Test Execution

```bash
npm run test:unit
```

- 100% pass rate required — no skipped or failing tests
- Test coverage must be >= 80% for new/modified code
- Critical business logic must have 100% coverage
- Every source file must have a corresponding `.test.ts` file

### Step 4: Integration Test Execution

```bash
npm run test:integration
```

- All integration tests must pass
- API endpoint tests must cover success and error paths
- Database operations must be tested with proper setup/teardown

### Step 5: Build Verification

```bash
npm run build
```

- Clean build from scratch must succeed
- No compilation warnings
- Output artifacts must be generated in `/dist/`
- Frontend build must produce valid bundles

### Step 6: Runtime Smoke Test

```bash
# Start the server and verify health
npx crewly start --no-browser
curl http://localhost:3000/health
```

- Server must start without errors
- Health endpoint must return 200
- No uncaught exceptions in startup logs

## Checklist

- [ ] TypeScript compilation passes with strict mode (`npm run typecheck`)
- [ ] Zero type errors
- [ ] No `any` types in new/modified code
- [ ] ESLint passes (`npm run lint`)
- [ ] Unit tests pass with 100% success rate (`npm run test:unit`)
- [ ] Test coverage >= 80% for new/modified code
- [ ] Integration tests pass (`npm run test:integration`)
- [ ] Build succeeds (`npm run build`)
- [ ] No compilation warnings
- [ ] Runtime smoke test passes (health check returns 200)

## Exceptions

- **Documentation-only deployments**: Spec or README updates that don't change runtime code may skip Steps 3-4 (test execution) but must still pass typecheck and build.
- **Emergency hotfixes**: May proceed with a reduced gate (typecheck + unit tests only) if approved by the Team Leader, but a full gate pass must follow within 24 hours.
