# Security Scan

**Trigger**: before_merge
**Applies to**: qa-engineer
**Version**: 1.0.0

## Overview

Mandatory security review for every pull request before merge. Covers OWASP Top 10 vulnerabilities, dependency auditing, secrets exposure detection, and input validation verification.

## Steps

1. **OWASP Top 10 scan** — Review all changed code against the current OWASP Top 10 categories:
   - A01: Broken Access Control — Check authorization on every endpoint and resource access.
   - A02: Cryptographic Failures — Verify no plaintext secrets, weak hashing, or insecure TLS usage.
   - A03: Injection — Check for SQL injection, NoSQL injection, command injection, and XSS in all user inputs.
   - A04: Insecure Design — Evaluate threat model for new features and data flows.
   - A05: Security Misconfiguration — Verify CORS, CSP headers, and default credentials are not exposed.
   - A06: Vulnerable Components — Cross-reference dependencies against known CVE databases.
   - A07: Authentication Failures — Check session management, token validation, and password policies.
   - A08: Data Integrity Failures — Verify serialization safety, CI/CD pipeline integrity.
   - A09: Logging Failures — Ensure security events are logged without leaking sensitive data.
   - A10: SSRF — Check all outbound HTTP calls for user-controlled URL parameters.

2. **Dependency audit** — Run `npm audit` or equivalent to identify known vulnerabilities in direct and transitive dependencies. Flag any `high` or `critical` severity findings as blockers.

3. **Secrets exposure check** — Scan the diff for:
   - API keys, tokens, passwords, or connection strings.
   - `.env` files or credentials files being committed.
   - Hardcoded secrets in source code or configuration.
   - Private keys or certificates.

4. **Input validation review** — For every new endpoint or user-facing input:
   - Verify server-side validation exists (do not rely on client-side only).
   - Check for proper type coercion and bounds checking.
   - Ensure parameterized queries for database operations.
   - Verify file upload restrictions (type, size, content validation).

5. **Produce security assessment** — Summarize findings with severity ratings (Critical / High / Medium / Low / Info), remediation guidance, and an overall risk rating.

## Checklist

- [ ] No SQL/NoSQL injection vectors in queries or ORM calls
- [ ] No XSS vectors — all user content is escaped/sanitized before rendering
- [ ] No command injection — user input never passed to `exec`, `spawn`, or `eval`
- [ ] Authorization checked on every endpoint (not just authentication)
- [ ] No secrets, API keys, or credentials in the diff
- [ ] `.env`, `.key`, and credential files are in `.gitignore`
- [ ] `npm audit` shows no high/critical vulnerabilities
- [ ] All user inputs validated server-side with proper type checking
- [ ] File uploads restricted by type, size, and content validation
- [ ] CORS configuration is restrictive (no wildcard `*` in production)
- [ ] Security-relevant events are logged (login attempts, permission changes)
- [ ] Sensitive data (passwords, tokens) never appears in logs
- [ ] Outbound HTTP requests do not accept user-controlled URLs without allowlist

## Exceptions

- **Internal tooling PRs** (not exposed to the internet): May downgrade SSRF and CORS checks to advisory. All other checks remain mandatory.
- **Test-only PRs**: Secrets check still applies (test fixtures must not contain real credentials). OWASP scan may be skipped for unit test files.
- **Emergency hotfixes**: Security scan is still required but may be performed post-merge within 24 hours. The hotfix must be tagged for follow-up review.
