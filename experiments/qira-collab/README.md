# Qira Collab — Cloudflare developer preview

**Live configuration (2026-10-12)**

- Worker: `qira-collab-dev`
- Tentative URL: https://qira-collab-dev.bryanleonard237.workers.dev
- MCP URL: https://qira-collab-dev.bryanleonard237.workers.dev/mcp
- D1 database: `qira-collab-dev-db` (`f731dc90-fa42-4ccc-be9b-bfb9c022b1a1`)
- Isolated git branch: `feature/collabhub-cloudflare-dev-20261012`

## Implemented
An independent module Worker with a minimal browser UI, stateless JSON-RPC Streamable HTTP MCP handler (11 tools), D1 tables for projects, project-scoped editor/viewer/admin tokens (SHA-256 hashes in D1), tasks with optimistic concurrency via `version`, messages, shared documents with version checks, and an audit event log. There is no agent auto-execution or code deploy integration.

## Immediate blocker
The connector refused to write `BOOTSTRAP_TOKEN` as a Worker secret. **Do not disable authentication**. On an authorized machine with access to Bryan's Cloudflare account, run:
```powershell
npx wrangler whoami
npx wrangler secret put BOOTSTRAP_TOKEN --name qira-collab-dev
```
Use a new unique high-entropy private token. Keep it out of the repository. The secret must be bound to this same script. After adding the secret, test auth and create a project via UI at the workers.dev URL. Note that the developer chat created a private token file locally, but rotating/generating a fresh token in a private shell is preferable.

The live deployment API returned HTTP 200 and 100% version deployment with a D1 binding. External health URL could not be fetched from this assistant runtime (outbound requests to this workers.dev host are blocked by the tools' network policy), so public HTTP accessibility is **not verified**.

## Smoke checks
```powershell
$base = "https://qira-collab-dev.bryanleonard237.workers.dev"
Invoke-RestMethod "$base/health"
# Should be 401:
try { Invoke-WebRequest "$base/api/projects" } catch { $_.Exception.Response.StatusCode }
$token=Read-Host "Paste admin token"
Invoke-RestMethod -Uri "$base/api/projects" -Headers @{Authorization="Bearer $token"}
```
Create project via web UI; issue one project `editor` token for each collaborator. Token values are shown only once. Test REST and MCP with the same bearer tokens. Revoke tokens in `GET/DELETE /api/projects/:project_id/tokens/:token_hash` if compromised.

## Agent connection after activation

With a separately issued project editor token in the local shell environment:

```powershell
$env:QIRA_COLLAB_TOKEN = Read-Host "Paste project token"
codex mcp add qira-collab --url https://qira-collab-dev.bryanleonard237.workers.dev/mcp --bearer-token-env-var QIRA_COLLAB_TOKEN
```

The environment variable must be available to the Codex process when it starts. Each collaborator must have a distinct project-scoped token; never use the Cloudflare bootstrap/admin token in Codex.

After activating the secret, verify via the live smoke harness:

```powershell
$env:QIRA_COLLAB_ADMIN_TOKEN = Read-Host "Admin token"
$env:QIRA_COLLAB_SMOKE_WRITE = "yes"
node experiments/qira-collab/smoke.mjs
```

The write test creates audit-named test projects and credentials, revokes its viewer test credential, and **never** modifies preexisting projects.

## MCP tools
`list_projects`, `get_project`, `list_tasks`, `create_task`, `update_task`, `list_messages`, `post_message`, `list_documents`, `create_document`, `update_document`, `get_activity`.

`POST /mcp` supports JSON-RPC `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` using stateless JSON responses. It requires `Authorization: Bearer <project token>`. Codex supports remote HTTP MCP using `--bearer-token-env-var` as shown above. Never commit token values.

**Consumer ChatGPT:** native custom MCP connection may require an OAuth 2.1 identity / authorization flow, verification, and user action. Not built; do not claim that ChatGPT account connection works until it has actually been tested.

## Security and product gaps for Codex
1. Add standards-compliant OAuth 2.1 + PKCE, OIDC identity, per-user tenancy and invitation acceptance, revocation audit, rotating tokens. Bind project permissions to authenticated human/agent identities, not arbitrary labels.
2. Enforce request throttling, abuse controls, tool input validation, project quotas, explicit invitation expiry, token last-used metadata, conflict-safe message pagination.
3. Create automated integration tests using real local D1 and deployed smoke tests including two-agent access boundaries and 409 version conflicts. Today's included test is a contract-level mocked smoke test.
4. Add interactive UI for task status, shared documents, team invitation acceptance, GitHub PR integration, and read-only audit trails.
5. Add agent executor/queue separately with human approval for external side effects; no background AI-to-AI execution exists yet.
6. Restrict CORS to allowed origins, add secure OAuth token storage, and require owners to approve releases before production.
7. Preserve the independent Worker/database and do not alter unrelated production apps.

## Run tests
```bash
node --test worker.test.mjs
```
Node 22+, no external packages for contract tests.

## Wrangler config
The included `wrangler.jsonc` binds the **existing** D1 DB; do not run migrations against any other DB. Schema file mirrors the live initialized schema. Only deploy with the correct Cloudflare account and after reviewing the diff; uploading a script via the API that omits existing secret bindings can remove them. Use Wrangler's normal secret-preserving deployment pathway.
