# Quality Gates

**Trigger**: before_deploy
**Applies to**: *
**Version**: 1.0.0

## Overview

Mandatory quality checks that must pass before any deployment. No exceptions. If any gate fails, the deployment is blocked until the issue is resolved.

## Steps

1. **TypeScript compilation** — Run `npm run build`. Zero errors and zero warnings required.
2. **Unit test suite** — Run `npm run test:unit`. 100% pass rate required. No skipped tests allowed in CI.
3. **Integration test suite** — Run `npm run test:integration`. All integration tests must pass.
4. **Lint check** — Run `npm run lint`. No errors allowed. Warnings must be under 5.
5. **Build artifact verification** — Confirm compiled output in `/dist/` runs correctly. Verify health endpoint responds.
6. **Environment config validation** — Ensure all required environment variables are set for the target environment.

## Checklist

- [ ] `npm run build` exits with code 0
- [ ] `npm run test:unit` — all tests pass
- [ ] `npm run test:integration` — all tests pass
- [ ] `npm run lint` — no errors
- [ ] No TypeScript `any` types in new code
- [ ] No `TODO` comments without linked GitHub issues
- [ ] Health endpoint responds with 200 OK
- [ ] Environment variables validated for target environment
- [ ] Database migrations (if any) tested in staging first

## Exceptions

- **Rollback deployments** may bypass gates 2-4 if reverting to a previously validated version.
- **Infrastructure-only changes** (nginx config, Docker compose) may skip gates 1-4 but must pass gate 6.
