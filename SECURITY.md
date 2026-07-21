# Security Policy

Arkimede is built to run untrusted code and connect to internal systems, so we take
security reports seriously. Thank you for helping keep the project and its users safe.

## Supported versions

Security fixes are applied to the latest released version on the `master` branch.
Older revisions are not maintained — please upgrade before reporting.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.** Public disclosure before a fix is available puts
every deployment at risk.

Instead, report privately through either channel:

- **GitHub Security Advisories** — use the repository's
  [**Security → Report a vulnerability**](../../security/advisories/new) button
  (preferred: it keeps the report private and lets us collaborate on a fix).
- **Email** — `info@rstonline.it` with the subject line `SECURITY: Arkimede`.

Please include, as far as you can:

- a description of the vulnerability and its impact;
- steps to reproduce, or a proof of concept;
- affected component (backend, executor, broker, frontend, a skill) and version/commit;
- any suggested mitigation.

## What to expect

- We aim to acknowledge a report within **72 hours**.
- We will confirm the issue, keep you updated on remediation, and agree on a
  coordinated disclosure timeline before any public write-up.
- With your consent, we are happy to credit you once a fix is released.

## Scope

Especially relevant, given the architecture:

- Tenant isolation gaps (a user reaching another tenant's files, data, or skills).
- Sandbox / skill-execution escapes (broker, job containers, the `run_in_sandbox`
  tool, egress-network confinement).
- SSRF and access-control bypasses on DataSources, internal APIs, or MCP servers.
- Authentication / authorization flaws (JWT handling, role and scope enforcement).
- Secret exposure.

Out of scope: findings that require a pre-existing admin/operator compromise, issues
in third-party dependencies without a demonstrated impact on Arkimede, and reports
generated solely by automated scanners without a working proof of concept.
