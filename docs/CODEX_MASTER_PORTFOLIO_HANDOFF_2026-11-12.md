# Codex cross-portfolio launch index — Qira LLC
**2026-11-12 | DRAFT | No credentials, customer contacts, private account data or live payment authority**

This public GitHub note is a **sanitized entry point**. The founder has a more complete PRIVATE handoff named `QIRA_CODEX_MASTER_HANDOFF_2026-11-12.md` supplied through ChatGPT. Ask the owner to attach it in the Codex workspace if you need customer-specific context. Never commit that full file to this public repository.

## Mission
Recover and produce real revenue using existing products, not a portfolio-wide rewrite. Priorities: (1) Ah Crap Cleanup sales conversion, (2) Qira's $199 Workflow Diagnosis and implementation projects, (3) MemeCoinAlerts paying subscriber growth, (4) Sitemapper/ShipCheck recurring monitoring only after known service blockers are resolved. Preserve all production systems.

## Critical: YES, MemeCoinAlerts is in scope
**https://memecoinalerts.app/** is a Solana token research and alert product with free Telegram entry, paid access, public call records and a referral program. Research a potential ~$10/week bundle (50/100 paying users) but do NOT replace current monthly plans without observing actual retention and billing. An earlier inspection saw Cloudflare Workers `memecoinalerts-canonical` and `microedge-backend`, with domain traffic through a Tunnel. **The authoritative production subscriber/payment ledger has NOT been established.** An inspected database with zero rows does not prove zero paid customers. Your first goal is to verify the real production routing, billing, subscription states, free-trial attribution and cancellation flow. Only then optimize the product and growth funnel.

**Must test:** public landing, referral attribution, free->Telegram->trial->paid journeys in safe test mode, webhooks/entitlements, active paid customers, MRR and churn. Differentiate actual subscribers from Telegram visits, trial starts, invoices and failed payments. Never imply token alert outcomes are guaranteed or that sampled price peaks were executable returns. No private keys or unapproved auto-trading.

## Existing products and repositories
| Product | Public address / source | Priority |
|---|---|---|
| Ah Crap Cleanup | https://ahcrapcleanup.com/ | Real local field-service revenue, recurring commercial bids after compliance review |
| Qira Workflow Diagnosis | https://audit.imagineqira.com/ | $199 fixed-scope audit, bounded implementation upsell |
| MemeCoinAlerts | https://memecoinalerts.app/ | **High:** reconcile true subscriptions and implement acquisition/retention |
| PumpFunBot | https://pumpfunbot.app/ ; https://bot.autohustle.online/ | Verify its actual source/data mapping before cross-promotion |
| Sitemapper | https://sitemapper.oortstack.com/ ; https://github.com/TheArtOfSound/Sitemapper | P0 R2 failure, restore monitoring truth |
| ShipCheck | https://shipcheck.imagineqira.com/ ; Sitemapper PR #3 | Free HTTP page diagnostics/AI fix brief, only proposed paid add-on |
| PTI | https://pti.imagineqira.com/ | Qualified commercial/government traffic analytics, later |
| WeSearch | https://wesearch.press/ | Verify real human users before promoting related products |
| Oort/Flows | https://github.com/TheArtOfSound/oort ; https://github.com/TheArtOfSound/flows | Preserve provenance/trust guarantees |
| GoodGame | https://github.com/TheArtOfSound/GoodGame | Game/creator network, downstream |
| Qira native agent / OS | https://github.com/TheArtOfSound/Qira ; https://github.com/TheArtOfSound/QiraOS | R&D track, not the short-term revenue sprint |

The portfolio contains multiple independent repos and deployments. Do not assume everything is in this `qira-hq` repository or that an endpoint and repo have a 1-to-1 match. Use Cloudflare/GitHub/connected source-of-truth inspection.

## P0 acknowledged operational failure
Sitemapper issue https://github.com/TheArtOfSound/Sitemapper/issues/4: Cloudflare R2 returned 10042 ('Please enable R2') and recent scheduled crawls failed to save snapshots. Confirm current state. Restore actual storage->snapshot->monitor->alert path with evidence before marketing paid monitoring.

Existing Codex handoff for ShipCheck: https://github.com/TheArtOfSound/Sitemapper/pull/3 (draft/unmerged), branch `codex/shipcheck-revenue-flow-20261112`. Read `docs/CODEX_SHIPCHECK_PRODUCTIZATION_2026-11-12.md`, `experiments/shipcheck/DEPLOYMENT.md` and project `AGENTS.md`. Do not merge until SSRF, DNS safety, anti-abuse and tests pass. A 200 response does NOT prove a checkout works.

## Sales and service execution
- Ah Crap: support existing owner-approved inbound conversations; do not restart old personal customer threads. For HOA and apartment services verify trade-name registration, insurance and ability to fulfill safely before signing. Avoid extending the $25 recurring founder promotion to unrelated one-time landscaping/pressure washing.
- Qira: sales offer is the `$199 Workflow Diagnosis`, not an invented consulting platform. Verify checkout, booking and deliverable. Apply to genuine requests for API/webhook/CRM/website/AI integration. Preserve sending reputation; do NOT bulk spam unsolicited founders or use an alternative sender to evade abuse reports.
- MemeCoinAlerts: measure actual subscribers and net weekly cohort retention. Target honest product-led growth and opt-in referrals. Test `$10/week` as an offer **only after** user and price validation and fully working billing, with explicit cancellation terms. Never assume that 100 weekly subscribers equals guaranteed passive income.
- Maintain a verifiable funnel: **research -> opted-in/eligible contact -> actual sent -> human response -> proposal -> contract -> paid -> repeat buyer**. Distinguish stage counts.
- Never make unsolicited AI-recorded voice marketing calls without recipient-specific consent and disclosure. Respect CAN-SPAM and platform rules.

## Codex execution order
1. Inspect authorized repos, deployments, tests, data flow and Stripe connections **read-only**. Produce a proof-linked portfolio map; identify authoritative MemeCoinAlerts subscriber and payment data.
2. Validate and fix revenue-blocking flows; prioritize R2 outage and existing SaaS auth/checkout/fulfillment failures. Stage and test changes.
3. Improve Ah Crap quote->booking->payment and Qira workflow-audit intake->payment->deliverable. Neither should invent capacity, insurance or customer promises.
4. Add opt-in attribution and retention metrics to MemeCoinAlerts; trial->paid improvements; honest evidence of outcomes. Reuse PumpFunBot/WeSearch distribution only when a real, relevant traffic source is confirmed.
5. Validate a ShipCheck paid monitoring add-on against Sitemapper's existing subscription tiers; avoid two duplicate backends.
6. Only then expand to other validated product revenue tracks.

## Task execution contract
- First inspect existing `AGENTS.md`, README, CI tests and current deploys before editing.
- Implement small commits on isolated branches; run tests, type checks, full production-funnel regression in staging.
- Cite screenshots/logs and exact live outcomes. Distinguish attempted, sent, delivered, replied, paid; report 0 if 0.
- Protect all credentials, on-chain secrets, customer addresses/phone numbers/photos, account IDs and personal financial data.
- Do not activate plans, incur costs, create Stripe live charges, accept loan terms, sign contracts or make irreversible changes without explicit authority.
- Do not claim ongoing work without an actual active automation/task and confirmed run result.

**How to start:**
```
Read this file, then read the founder's PRIVATE QIRA_CODEX_MASTER_HANDOFF_2026-11-12.md
attached in my workspace. Build the cross-project inventory, then work on the
highest verified revenue blocker first. Include MemeCoinAlerts as a top
subscription-growth priority. Keep each existing application working.
Report concrete evidence on every completed step.
```
