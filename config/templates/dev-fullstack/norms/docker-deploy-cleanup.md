# Docker Deploy Cleanup SOP

**Trigger**: after_deploy
**Applies to**: developer, team-leader
**Version**: 1.0.0

## Overview

Standard operating procedure for cleaning up Docker resources after every deployment. Prevents disk space exhaustion on development machines from accumulated build cache and old images.

## Steps

1. **Prune dangling resources** — Run `docker system prune -f` to remove dangling images, stopped containers, and unused networks.
2. **Remove old images** — If multiple versions of the deployed image exist locally, remove all but the latest: `docker rmi <old-image:old-tag>`.
3. **Verify disk recovery** — Check that `docker system df` shows reasonable usage. Flag if total usage exceeds 20 GB.
4. **Never build simultaneously** — Only build one Docker image at a time. Concurrent builds compete for disk and CPU, causing flaky builds.

## Checklist

- [ ] `docker system prune -f` executed after deploy
- [ ] Only the current version image remains locally for each service
- [ ] No dangling `<none>` images present (`docker images --filter dangling=true`)
- [ ] Build cache reclaimed (check `docker system prune` output)

## Exceptions

- Skip cleanup if deploying multiple services in sequence — run cleanup once at the end.
- Do not prune named volumes (`docker volume prune`) without explicit approval, as they may contain persistent data.
