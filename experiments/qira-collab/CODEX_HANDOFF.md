# Codex execution handoff · Qira Collab

**You are taking over an existing, partially activated Cloudflare project. Do not recreate it. Do not change or stop any unrelated service.**

## Ground truth

- Cloudflare account: `eaa59df7f198cbd481763fc7c743b7f4`
- Worker: `qira-collab-dev` (already deployed with D1 binding)
- Public UI: https://qira-collab-dev.bryanleonard237.workers.dev/
- MCP: https://qira-collab-dev.bryanleonard237.workers.dev/mcp
- Database: `qira-collab-dev-db` (`f731dc90-fa42-4ccc-be9b-bfb9c022b1a1`); schema already migrated.
- Repo: `TheArtOfSound/qira-hq`, development branch `feature/collabhub-cloudflare-dev-20261012`; draft PR https://github.com/TheArtOfSound/qira-hq/pull/3
- Code folder: `experiments/qira-collab/`
- CI: nine contract checks PASSED, deployed /health PASSED, live unauthenticated /api/projects HTTP 401 PASSED (GitHub Actions run 38301760133).
- Current blocker: Cloudflare connector rejected setting `BOOTSTRAP_TOKEN` Worker secret. Secret is **not installed** as of handoff. The platform refused the tool operation, not the Worker build; avoid any attempt to bypass platform controls.

## Priority 0: complete activation and real tests

1. Authenticate through the authorized Cloudflare account using Wrangler on the owner's Windows machine. Verify account ID and existing Worker and D1 database. Do not create duplicates.
2. Create or receive a fresh high-entropy owner token in a private shell. With Bryan's authorization, install it as the Worker secret using `npx wrangler secret put BOOTSTRAP_TOKEN --name qira-collab-dev`. Do not commit or print secrets, and do not remove the D1 binding. Verify the Worker still serves /health.
3. Run `node experiments/qira-collab/smoke.mjs` with `QIRA_COLLAB_ADMIN_TOKEN` in the process environment and `QIRA_COLLAB_SMOKE_WRITE=yes`. It creates two *new* audit-named test projects; tests project issuance, editor MCP initialize and tools/list, viewer read-only behavior, editor posting through tools/call, cross-project access denial, 409 optimistic concurrency, and token revocation. Do not call this completed without output proving each assertion.
4. Investigate any failing step and fix both source and live Worker; preserve secrets on subsequent deploys.

## Priority 1: connect two actual Codex clients

1. From the UI, create a real project and issue **distinct** editor tokens to each collaborator. Keep admin token only for the owner.
2. On each Windows machine, set `QIRA_COLLAB_TOKEN` locally and run `codex mcp add qira-collab --url https://qira-collab-dev.bryanleonard237.workers.dev/mcp --bearer-token-env-var QIRA_COLLAB_TOKEN`. Do not commit bearer secrets.
3. Agent A calls `create_task` and `post_message`. Agent B calls `list_tasks`, `list_messages`, `update_task`, and `create_document`. Agent A can read the updates. Confirm author fields are correctly scoped to the distinct tokens.
4. Do not claim full collaboration until both live clients can exchange data. The present app is persistent shared context, not autonomous multi-model orchestration.

## Priority 2: proper ChatGPT OAuth integration

Implement compliant OAuth 2.1 (authorization-code + PKCE S256), protected resource metadata, authorization-server discovery, audience/resource binding, refresh-token handling where supported, and per-user identity and consent. Prefer an established identity provider rather than a homemade authentication server. Add per-tool security schemes and correct unauthenticated WWW-Authenticate challenges. Verify with the user's authorized ChatGPT custom plugin flow and with two separate user accounts; plan/product entitlements may restrict access. Official guide: https://developers.openai.com/plugins/build/auth

## Priority 3: hardening and productization

- Upgrade from user-issued bearer-token labels to actual user identities, invite acceptance and expiring tokens.
- Rate limiting, quotas, pagination, request body size tests, secret rotation, security event auditing, XSS/CSRF assessments.
- Add richer UI: project documents, editable task status, audit timeline, collaborator roles, real-time updates.
- Optional GitHub integration: separate repo/install authorization per project and approval-gated code changes; never deploy or merge from arbitrary agent text.
- Then evaluate Cloudflare Durable Objects, Queues, Workflows for genuinely background agent-to-agent work. No autonomous code execution should be enabled without an explicit separate design and authorization.

## Done means proof

- Live health, unauthorized 401, authenticated admin project creation.
- Two independent project token holders exchanging context, with viewer write denied, cross-project denied.
- 409 conflict rather than silent overwrite.
- Revoked token denied afterward.
- Real Codex MCP round-trip.
- Real ChatGPT OAuth round-trip before claiming ChatGPT parity.
- CI green and evidence in the PR. Never merge draft PR until all intended release gates pass.


---
# PHASE 2 UPDATE — 2026-10-12 (read this first)

The Phase 2 hub is **already live**. Keep the existing Worker `qira-collab-dev`, D1 `qira-collab-dev-db`, project `a21e47e9-e543-4047-83b9-68bfc1750809` and discussion thread `2a481de8-9c2c-4bf3-b5b9-a6a3708a5409`. The owner `BOOTSTRAP_TOKEN` secret is installed; after the v2 deployment Cloudflare showed it still bound. Do not recreate resources or assume the old secret blocker remains.

The current UI and MCP now implement project context snapshots, threaded conversations and replies, agent-addressed inbox with ack, versioned notes/plans/decisions/handoffs, collaborator roster, and GitHub public pull-request activity for registered repos. Read `AGENT_PROTOCOL.md` and `schema-v2.sql`. Cloudflare API deployment succeeded; GitHub Actions verified public health, access-denied responses, and an in-memory SQLite two-agent collaboration suite. **Live authenticated browser/Codex-to-Codex exchange still needs proof.**

NEXT: Issue independent project editor tokens to the two collaborators; stop sharing the bootstrap owner token; connect two Codex clients, have each send/receive a thread reply and directed inbox item and ack it. Then implement standards-compliant OAuth 2.1 AuthorizationServer + ResourceServer with `@cloudflare/workers-oauth-provider@1`, protected-resource metadata, PKCE, refresh, external identity, per-project consent, and separate user identities. See https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/ and https://developers.openai.com/plugins/build/auth. ChatGPT custom MCP install depends on user entitlements and action approval. No autonomous wake-up of consumer chats exists; build a separate opt-in execution runner with rate limits, human approvals, and safe sandbox boundaries.

GitHub integration currently registers the public repository and reads its open PR list. It is **read-only and pull-based**, without private GitHub credentials or webhooks. For autonomous exchanges, design an agent runner or webhook notification system separately; never claim a passive inbox has triggered another LLM.

When deploying, preserve `BOOTSTRAP_TOKEN` using `keep_bindings:['secret_text','secret_key']`; verify Worker binding settings after every update. Do not alter unrelated Cloudflare services. Keep PR #3 draft until user review and end-to-end authenticated tests.
