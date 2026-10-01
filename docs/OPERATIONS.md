# Command Center Operations

## Health

`GET /health` is constant-time and reveals no secrets. In production, healthy process state does not imply the external adapters are authorized; integration state belongs on the live status panel with last success/failure evidence.

## Data and backups

The SQLite database is the durable control plane for idempotency, ownership, blocker aggregation, audit entries, and Slack surface references. Stop the process or use SQLite's online backup API before copying it. Retain at least one verified restore point before schema or deployment changes.

Event rows use bounded processing leases. A failed event may retry immediately; an abandoned `processing` row may be reclaimed only after its lease expires. Gmail message IDs and Stripe PaymentIntent IDs provide the business-level dedupe boundary when ingestion event IDs differ.

## Incident priorities

1. Disable inbound event delivery if customer-impacting mutations are suspected.
2. Preserve the SQLite file and logs; do not delete event or audit rows.
3. Verify Gmail, Close, Stripe, and monday directly before changing Slack display state.
4. If payment attribution is uncertain, leave the opportunity pre-Won and render Payment Needs Review.
5. If duplicate ownership is suspected, pause outbound activity for that root domain and inspect the claim plus Gmail/Close evidence.
6. If Slack is unavailable, canonical systems remain authoritative; restore Slack surfaces after Slack recovers.

## Noise policy

- Run start/end updates the status surface; no top-level heartbeat.
- Run lifecycle detail is appended beneath one daily run-log parent.
- A stalled run posts only after the configured threshold and only once per blocker key.
- Autoresponders, bounces, and DSNs are counted; they post only when sender health changes.
- Repeated blockers update the existing card.
- Unchanged briefs are suppressed.
- Briefs are capped at 12 Block Kit blocks including Actor/DEMO context.

## Production enablement gate

Production mode requires Slack credentials and an ingestion bearer token at startup. Business mutations still fail closed until live adapters replace the unconfigured implementations. Enable one adapter at a time and add a contract test proving read-back and idempotency before routing production events to it.
