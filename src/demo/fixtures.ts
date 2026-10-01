import type { DealSnapshot, PaidJobScope, PaymentEvidence, RevenueEvent } from "../domain/types.js";

export const DEMO_DEAL: DealSnapshot = {
  opportunityId: "demo-opp-001",
  company: "Saguaro Smiles (DEMO)",
  rootDomain: "example-dental.test",
  contactName: "Dr. Jane Doe",
  contactRole: "Owner Dentist",
  email: "jane@example-dental.test",
  phone: "(480) 555-0100",
  owner: "Viktor",
  offer: "Website Fix / Conversion Sprint",
  expectedValueCents: 75_000,
  currency: "USD",
  stage: "Payment Link Sent",
  daysInStage: 1,
  lastInteraction: "2026-10-01T15:00:00-07:00",
  lastInboundExcerpt: "The scope looks good. Can we start next week?",
  nextAction: "Confirm kickoff inputs and acknowledge payment",
  nextFollowUpAt: "2026-10-02T09:00:00-07:00",
  proposalStatus: "Accepted",
  paymentStatus: "Requested",
  dedupeCheckedAt: "2026-10-01T14:55:00-07:00",
  optOut: false,
  identityAmbiguous: false,
  evidence: [
    { label: "Gmail thread", url: "https://gmail.example.test/thread/demo-001", source: "gmail", externalId: "demo-thread-001" },
    { label: "Close opportunity", url: "https://close.example.test/opportunity/demo-opp-001", source: "close", externalId: "demo-opp-001" },
    { label: "Calendly", url: "https://calendly.example.test/event/demo-001", source: "calendly", externalId: "demo-event-001" },
  ],
};

const demoDeal = (opportunityId: string, stage: DealSnapshot["stage"], overrides: Partial<DealSnapshot> = {}): DealSnapshot => ({
  ...DEMO_DEAL,
  opportunityId,
  stage,
  evidence: DEMO_DEAL.evidence.map((item) => item.source === "close" ? { ...item, externalId: opportunityId, url: `https://close.example.test/opportunity/${opportunityId}` } : { ...item }),
  ...overrides,
});

export const DEMO_DEALS: DealSnapshot[] = [
  DEMO_DEAL,
  demoDeal("demo-opp-reply", "Contacted", { nextAction: "Respond to the verified human reply" }),
  demoDeal("demo-opp-meeting", "Replied", { nextAction: "Prepare meeting brief" }),
  demoDeal("demo-opp-proposal", "Price Agreed", { nextAction: "Send verified proposal" }),
  demoDeal("demo-opp-payment-link", "Contract Sent", { nextAction: "Send payment link" }),
  demoDeal("demo-opp-claim", "Qualified", { nextAction: "Claim before first touch" }),
];

export const DEMO_PAYMENT: PaymentEvidence = {
  stripeAccountId: "acct_1TrCD18W7UytlyLE",
  paymentIntentId: "pi_demo_saguaro_001",
  status: "succeeded",
  amountPaidCents: 75_000,
  totalContractCents: 75_000,
  currency: "USD",
  paymentKind: "full",
  recurring: false,
  attributedOpportunityId: DEMO_DEAL.opportunityId,
  attribution: "exact",
  succeededAt: "2026-10-03T14:12:00-07:00",
  dashboardUrl: "https://stripe.example.test/payments/pi_demo_saguaro_001",
};

export const DEMO_JOB: PaidJobScope = {
  scope: ["Fix mobile booking CTA", "Add click-to-call and lead form", "Run a speed pass targeting <3s LCP"],
  outOfScope: ["New site build", "SEO retainer", "Ongoing support"],
  deliverables: [
    { name: "Mobile booking CTA", acceptance: "Visible and working on current iOS and Android browsers" },
    { name: "Lead paths", acceptance: "Call and form events reach the agreed destination" },
    { name: "Performance pass", acceptance: "Documented before/after mobile LCP result" },
  ],
  clientNeeds: ["CMS login", "Logo files", "Booking tool access"],
  deadline: "2026-10-10",
  kickoffBy: "2026-10-04",
  agreementEvidence: { label: "Written agreement", url: "https://gmail.example.test/thread/demo-001", source: "gmail" },
  fulfillmentOwner: "Bryan",
};

const at = "2026-10-01T23:15:00-07:00";
const base = (id: string, actor = "ChatGPT Revenue OS") => ({ id, occurredAt: at, demo: true as const, actor, evidence: DEMO_DEAL.evidence });

export const DEMO_EVENTS: Record<string, RevenueEvent> = {
  "human-reply": { ...base("demo-human-reply-001", "System / Gmail"), type: "reply.received", source: "gmail", data: { deal: demoDeal("demo-opp-reply", "Contacted"), messageId: "gmail-demo-human-001", mailbox: "bryan@imagineqira.com", classification: "human", excerpt: "The scope looks good. Can we start next week?" } },
  autoresponder: { ...base("demo-autoresponder-001", "System / Gmail"), type: "reply.received", source: "gmail", data: { deal: demoDeal("demo-opp-reply", "Contacted"), messageId: "gmail-demo-auto-001", mailbox: "bryan@imagineqira.com", classification: "autoresponder", excerpt: "Thanks for contacting us. We received your message." } },
  bounce: { ...base("demo-bounce-001", "System / Gmail"), type: "reply.received", source: "gmail", data: { deal: demoDeal("demo-opp-reply", "Contacted"), messageId: "gmail-demo-bounce-001", mailbox: "bryan@imagineqira.com", classification: "bounce", excerpt: "550 address not found", senderHealthChanged: false } },
  meeting: { ...base("demo-meeting-001", "System / Calendly"), type: "meeting.booked", source: "calendly", data: { deal: demoDeal("demo-opp-meeting", "Replied", { meetingAt: "2026-10-02T10:00:00-07:00" }) } },
  proposal: { ...base("demo-proposal-001", "Viktor"), type: "proposal.sent", source: "close", data: { deal: demoDeal("demo-opp-proposal", "Price Agreed", { nextAction: "Review proposal engagement and prepare follow-up" }) } },
  "payment-link": { ...base("demo-payment-link-001", "Viktor"), type: "payment.requested", source: "stripe", data: { deal: demoDeal("demo-opp-payment-link", "Contract Sent") } },
  payment: { ...base("demo-payment-001", "System / Stripe"), type: "payment.succeeded", source: "stripe", data: { deal: DEMO_DEAL, payment: DEMO_PAYMENT, job: DEMO_JOB } },
  "ambiguous-payment": { ...base("demo-payment-ambiguous-001", "System / Stripe"), type: "payment.succeeded", source: "stripe", data: { deal: DEMO_DEAL, payment: { ...DEMO_PAYMENT, paymentIntentId: "pi_demo_ambiguous_001", attribution: "ambiguous" }, job: DEMO_JOB } },
  blocker: { ...base("demo-blocker-001", "ChatGPT Revenue OS"), type: "blocker.observed", source: "gmail", data: { key: "gmail:sender-health:postal-footer", system: "Gmail", action: "Send first touch", exactFailure: "Required postal address footer is not configured", businessImpact: "Blocks all email first touches", revenueImpact: "No new outbound pipeline", owner: "Bryan", smallestFix: "Approve the Qira postal address and add it to the sender template", status: "Open", evidence: { label: "Run evidence", url: "https://airtable.example.test/run/demo-001", source: "airtable" } } },
  status: { ...base("demo-status-001"), type: "run.status", source: "airtable", data: { revenueOsState: "paused", operators: [{ name: "ChatGPT", state: "maintenance", focus: "Revenue OS safety" }, { name: "Viktor", state: "reviewing", focus: "Command Center acceptance" }], lastSuccessfulRunAt: "2026-09-30T21:05:00-07:00", nextScheduledRunAt: "Paused pending verification", senderHealth: [{ mailbox: "Gmail", status: "caution" }, { mailbox: "Outlook", status: "unknown" }], topBlockers: [{ key: "postal-footer", summary: "Postal footer is not approved", owner: "Bryan", status: "Open" }], integrations: [{ system: "close", status: "healthy", failureCount: 0, lastSuccessAt: at }, { system: "gmail", status: "caution", failureCount: 2, lastFailureAt: at }] } },
  "run-start": { ...base("demo-run-start-001"), type: "run.started", source: "airtable", data: { summary: "Scheduled revenue sprint started", status: { revenueOsState: "running", runId: "DEMO-RUN-001", runAgeMinutes: 0, operators: [{ name: "ChatGPT", state: "running" }, { name: "Viktor", state: "idle" }], senderHealth: [{ mailbox: "Gmail", status: "healthy" }], topBlockers: [], integrations: [{ system: "close", status: "healthy", failureCount: 0 }] }, material: { humanReplies: 0, meetings: 0, payments: 0, newBlockers: 0, senderHealthChanged: false, stalledMinutes: 0 } } },
  "run-end": { ...base("demo-run-end-001"), type: "run.ended", source: "airtable", data: { summary: "Scheduled sprint ended with no material change", status: { revenueOsState: "idle", runId: "DEMO-RUN-001", runAgeMinutes: 8, operators: [{ name: "ChatGPT", state: "idle" }, { name: "Viktor", state: "idle" }], senderHealth: [{ mailbox: "Gmail", status: "healthy" }], topBlockers: [], integrations: [{ system: "close", status: "healthy", failureCount: 0 }] }, material: { humanReplies: 0, meetings: 0, payments: 0, newBlockers: 0, senderHealthChanged: false, stalledMinutes: 0 } } },
  brief: { ...base("demo-brief-001"), type: "brief.requested", source: "airtable", data: { period: "Evening", asOf: at, moneyCollectedCents: 75_000, currency: "USD", humanReplies: 1, meetings: 1, dealsAdvanced: ["Saguaro Smiles → Proposal Sent"], proposalsOrPaymentRequests: ["Saguaro Smiles payment link sent"], followUpsDue: ["Saguaro Smiles tomorrow 09:00"], newPipeline: ["1 qualified dental practice"], lostOrSuppressed: [], blockers: ["Postal footer approval blocks new first touches"], viktorFocus: "Prepare the Saguaro Smiles kickoff and resolve sender footer", changed: true } },
};
