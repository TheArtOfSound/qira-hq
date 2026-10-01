# Qira Slack Command Center — Architecture Assessment

Date: 2026-09-30 (America/Phoenix)

## Existing repository

`qira-hq` is currently a public GitHub Pages repository containing a static LOLM research dashboard (`index.html`) and JSON research data. It has no application runtime, Slack integration, persistence layer, deployment manifest, environment pattern, or test harness. GitHub Pages publishes `main` from the repository root.

The command center will therefore be added as an isolated Node/TypeScript service under `src/`, leaving the existing Pages asset paths intact. Production business state will not be stored in the static site.

## Phase 1 architecture

- **Transport:** a small HTTP service verifies Slack request signatures, receives events and actions, and calls Slack Web API through a narrow client.
- **Core:** typed revenue events pass through one router that enforces source-of-truth and safety rules before rendering or writing anything.
- **Persistence:** SQLite stores idempotency keys, domain ownership, blocker aggregates, audit records, and Slack message references. Unique keys and transactions make claims and event replays concurrency-safe.
- **Adapters:** Close, Gmail, Stripe, Calendly, DocuSign, Airtable, and monday are interfaces. Phase 1 ships fail-closed stubs plus synthetic demo adapters; a missing live adapter can never silently become truth.
- **Slack UX:** renderers produce Block Kit for live status, human replies, deal cards, blockers, briefs, payment review, and `PAID JOB READY`. Status and deal surfaces are updated in place using stored message references.
- **Demo:** synthetic `.test` identities only. Demo mode cannot invoke customer messaging or production mutation adapters.

## Authority boundaries

| Domain | Canonical system | Slack behavior |
| --- | --- | --- |
| Communication | Gmail | Link/excerpt only; draft actions only |
| Pipeline | Close | Write Close first, read back, then refresh Slack |
| Payment | Qira Stripe account configured as `acct_1TrCD18W7UytlyLE` | `Won` requires an attributable succeeded payment |
| Booking | Calendly | Display verified booking state |
| Agreements | DocuSign or attributable written terms | Display evidence; ambiguity blocks handoff |
| Run ledger | Airtable | Read verified run metrics and timestamps |
| Fulfillment | monday | Create/reconcile handoff after verified payment |
| Coordination | Slack | Views and actions, never hidden canonical truth |

## Confirmed product requirements from Viktor

1. A quiet day should produce almost no top-level messages.
2. Run start/end events update one live status surface and a daily thread; they are not alerts.
3. Human replies and booked meetings are the only normal hot-inbox events.
4. Claims are keyed by normalized root domain and must include recent Gmail and Close dedupe evidence.
5. Repeated blockers update an occurrence count rather than create new alerts.
6. Counts name their source and `as of` time.
7. Buttons may draft customer communication but never send it.

## Existing conflict requiring remediation

The legacy public `index.html` contains a client-side access credential. Browser-side checks do not provide authentication, and Git history remains public even after a source edit. This credential must be treated as exposed and rotated anywhere it was reused. The Phase 1 service does not consume or copy it. Replacing the Pages access model requires a separate deployment decision (for example, Cloudflare Access) so the existing research dashboard is not accidentally made less available during this build.

## Deployment shape

The service targets Node 24+ with no paid runtime dependency. It can run locally, on a small container, or behind a Cloudflare Tunnel. SQLite must live on a persistent volume. GitHub Pages continues to publish the legacy static dashboard until a deliberate migration is approved.
