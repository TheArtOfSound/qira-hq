# Qira HQ

This repository contains the existing static LOLM research dashboard and the Qira Slack Command Center service. The command center is a low-noise, evidence-backed operator layer for Qira revenue work; it does not replace Gmail, Close, Stripe, Calendly, DocuSign, Airtable, or monday as canonical systems.

Phase 1 foundation is implemented on the `codex/slack-command-center` branch. Production adapters are intentionally fail-closed until their credentials and API mappings are configured. DEMO mode is fully synthetic and cannot send customer-facing communication.

## What Phase 1 provides

- one persistent live Revenue OS status message, updated in place;
- high-signal human reply and meeting cards;
- autoresponder and bounce suppression;
- persistent deal cards with Close-first stage actions and no manual Won action;
- concurrency-safe domain ownership claims with Gmail + Close dedupe evidence;
- deduplicated blocker cards whose occurrence count updates in place;
- proposal, payment-request, payment-review, and `PAID JOB READY` cards;
- material-change-only morning, afternoon, and evening briefs;
- SQLite idempotency, message references, blocker state, ownership, and audit trail;
- a synthetic demo suite and HTTP demo endpoints;
- Slack signature verification, bounded request bodies, and authenticated event ingestion.

## Architecture

```text
Revenue events / Slack actions
            |
            v
  signature + schema gates
            |
            v
  CommandCenter event router
      |       |        |
      v       v        v
  policies  SQLite   canonical adapters
            |        Gmail / Close / Stripe
            |        Calendly / DocuSign / Airtable / monday
            v
     Slack Block Kit surfaces
```

SQLite is the command center's control-plane store, not a shadow CRM. It contains idempotency keys, claims, blocker aggregates, audit entries, and Slack message timestamps. Close remains pipeline truth. A succeeded, exactly attributed payment from the configured Qira Stripe account is required before the service writes `Won`.

See [the architecture assessment](docs/ARCHITECTURE_ASSESSMENT.md) for the inspected starting state and authority boundaries.

## Local setup

Requirements: Node 24+.

```bash
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
```

Start the safe local server:

```bash
DEMO_MODE=true DATABASE_PATH=data/demo.sqlite npm run dev
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/demo/scenarios
```

## DEMO mode

The default transport prints exact Slack Block Kit payloads to stdout:

```bash
npm run demo -- status
npm run demo -- human-reply
npm run demo -- autoresponder
npm run demo -- meeting
npm run demo -- proposal
npm run demo -- payment-link
npm run demo -- payment
npm run demo -- ambiguous-payment
npm run demo -- blocker
npm run demo -- brief
npm run demo -- all
```

`payment` automatically replays the same event to prove duplicate suppression. `blocker` sends a second observation with a new event ID to prove the card updates rather than reposts.

To render synthetic cards in one private Slack acceptance channel:

```bash
DEMO_MODE=true \
SLACK_BOT_TOKEN='set-locally' \
DEMO_SLACK_CHANNEL_ID='C0123456789' \
npm run demo -- all --slack
```

The channel override is mandatory: every demo surface is forced into that one channel. Fixtures use only reserved `.test` identities and links. Do not paste credentials into Slack, shell history, source files, or screenshots.

## Slack app configuration

Create or select a Qira-owned Slack app and install it only in the Qira workspace.

Bot token scopes for Phase 1:

- `chat:write` — create and update command-center messages;
- `channels:history` — only if a public channel event consumer is enabled later;
- `groups:history` — only if a private channel event consumer is enabled later.

Phase 2 commands will additionally require `commands`. The bot must be invited to each private destination channel. Do not grant admin, file, DM, or user-token scopes.

Configure:

- Interactivity request URL: `https://<service>/slack/actions`
- Event request URL: `https://<service>/slack/events`
- App-level events: none are required for the Phase 1 backend-ingest path.

The server verifies Slack's `v0` HMAC signature and rejects requests older than five minutes.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DEMO_MODE` | yes | `true` selects synthetic adapters; production defaults fail closed |
| `DATABASE_PATH` | yes | persistent SQLite file path |
| `PORT` | no | HTTP port, default `8787` |
| `QIRA_STRIPE_ACCOUNT_ID` | production | allowed Stripe account, default is the approved Qira ID |
| `SLACK_BOT_TOKEN` | production / live demo | Slack bot credential |
| `SLACK_SIGNING_SECRET` | production | verifies Slack requests |
| `QIRA_INGEST_TOKEN` | production | bearer token for internal `/events` ingestion |
| `DEMO_SLACK_CHANNEL_ID` | live demo | single private destination for all demo cards |
| `SLACK_*_CHANNEL_ID` | production | existing Revenue OS channel IDs |

## Production safety rules

1. Slack renders and coordinates; it does not become canonical pipeline or payment state.
2. Stage actions compare the expected Close stage, write Close, read back, and then refresh Slack.
3. A Slack button can never set `Won`.
4. Payment handling rejects the wrong account, non-succeeded status, ambiguous attribution, unknown deposit/full status, unknown recurring status, missing scope, missing deliverables, and missing fulfillment owner.
5. Claims use normalized root domains and a unique SQLite key. Both Gmail and Close dedupe evidence must be clear.
6. Demo records must use `.test` email, company, and evidence domains.
7. Buttons may open or draft; no Phase 1 button sends customer communication.
8. Secrets are environment-only and are never included in logs or health output.

## Deployment

The provided Dockerfile runs Node 24 as a non-root user. Mount `/app/data` on a persistent volume; SQLite must not live on an ephemeral filesystem. Terminate TLS in the hosting layer. A low-cost container behind Cloudflare Tunnel is compatible with the service; GitHub Pages cannot host the Node service.

Before production enablement:

1. implement and test the live adapter interfaces in `src/adapters/interfaces.ts`;
2. provision a Qira-owned Slack app and channel allowlist;
3. store secrets in the deployment secret manager;
4. run the full test suite and Viktor's DEMO acceptance;
5. verify the connected Stripe account identity independently;
6. take a SQLite backup and verify restore;
7. keep customer-facing outbound disabled.

## Repository security note

The inspected legacy `index.html` uses a client-side credential gate. That value is exposed by design in a public repository and Git history. Treat it as compromised and rotate it anywhere it was reused. This PR does not copy it into the command-center service or silently change the existing GitHub Pages behavior. Migrate the legacy dashboard behind real access control (for example, Cloudflare Access) in a separate, verified change.
