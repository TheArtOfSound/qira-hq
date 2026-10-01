export const SALES_STAGES = [
  "Qualified",
  "Contacted",
  "Replied",
  "Meeting Booked",
  "Scope Negotiation",
  "Price Agreed",
  "Proposal Sent",
  "Contract Sent",
  "Payment Link Sent",
  "Won",
  "Fulfillment Handoff",
  "Lost",
] as const;

export type SalesStage = (typeof SALES_STAGES)[number];
export type SourceSystem =
  | "gmail"
  | "close"
  | "stripe"
  | "calendly"
  | "docusign"
  | "airtable"
  | "monday"
  | "slack"
  | "demo";

export interface EvidenceLink {
  label: string;
  url: string;
  source: SourceSystem;
  externalId?: string;
}

export interface DealSnapshot {
  opportunityId: string;
  company: string;
  rootDomain: string;
  contactName: string;
  contactRole?: string;
  email: string;
  phone?: string;
  owner: string;
  offer: string;
  expectedValueCents?: number;
  currency: string;
  stage: SalesStage;
  daysInStage?: number;
  lastInteraction?: string;
  lastInboundExcerpt?: string;
  nextAction: string;
  nextFollowUpAt?: string;
  meetingAt?: string;
  proposalStatus?: string;
  paymentStatus?: string;
  dedupeCheckedAt?: string;
  optOut?: boolean;
  identityAmbiguous?: boolean;
  evidence: EvidenceLink[];
}

export interface PaymentEvidence {
  stripeAccountId: string;
  paymentIntentId: string;
  status: "succeeded" | "processing" | "failed";
  amountPaidCents: number;
  totalContractCents: number;
  currency: string;
  paymentKind: "deposit" | "full" | "unknown";
  recurring: boolean | null;
  attributedOpportunityId?: string;
  attribution: "exact" | "ambiguous" | "none";
  succeededAt?: string;
  dashboardUrl: string;
}

export interface PaidJobScope {
  scope: string[];
  outOfScope: string[];
  deliverables: Array<{ name: string; acceptance: string }>;
  clientNeeds: string[];
  deadline: string;
  kickoffBy?: string;
  agreementEvidence?: EvidenceLink;
  fulfillmentOwner: string;
}

export interface PipelineCounts {
  qualified: number;
  contacted: number;
  replied: number;
  meetings: number;
  scoped: number;
  proposal: number;
  paymentPending: number;
  won: number;
  revenueCollectedCents: number;
  currency: string;
  source: "close";
  asOf: string;
}

export interface IntegrationHealth {
  system: Exclude<SourceSystem, "demo">;
  status: "healthy" | "caution" | "down" | "unknown";
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureCount: number;
  latencyMs?: number;
  permissionProblem?: string;
}

export interface LiveStatus {
  revenueOsState: "idle" | "running" | "stalled" | "paused";
  runId?: string;
  runAgeMinutes?: number;
  operators: Array<{ name: string; state: string; focus?: string }>;
  lastSuccessfulRunAt?: string;
  nextScheduledRunAt?: string;
  senderHealth: Array<{ mailbox: string; status: "healthy" | "caution" | "blocked" | "unknown" }>;
  counts: PipelineCounts;
  topBlockers: Array<{ key: string; summary: string; owner: string; status: string }>;
  integrations: IntegrationHealth[];
}

export interface BlockerInput {
  key: string;
  system: string;
  action: string;
  exactFailure: string;
  businessImpact: string;
  revenueImpact: string;
  owner: string;
  smallestFix: string;
  evidence: EvidenceLink;
  status: "Open" | "Investigating" | "Waiting External" | "Fixed" | "Monitoring";
}

export interface RevenueBrief {
  period: "Morning" | "Afternoon" | "Evening";
  asOf: string;
  moneyCollectedCents: number;
  currency: string;
  humanReplies: number;
  meetings: number;
  dealsAdvanced: string[];
  proposalsOrPaymentRequests: string[];
  followUpsDue: string[];
  newPipeline: string[];
  lostOrSuppressed: string[];
  blockers: string[];
  viktorFocus: string;
  changed: boolean;
}

interface BaseEvent<T extends string, D> {
  id: string;
  type: T;
  occurredAt: string;
  source: SourceSystem;
  demo: boolean;
  evidence: EvidenceLink[];
  data: D;
}

export type RevenueEvent =
  | BaseEvent<"reply.received", { deal: DealSnapshot; classification: "human" | "autoresponder" | "bounce" | "unknown"; excerpt: string }>
  | BaseEvent<"meeting.booked", { deal: DealSnapshot }>
  | BaseEvent<"deal.updated", { deal: DealSnapshot; changed: string }>
  | BaseEvent<"proposal.sent", { deal: DealSnapshot }>
  | BaseEvent<"payment.requested", { deal: DealSnapshot }>
  | BaseEvent<"payment.succeeded", { deal: DealSnapshot; payment: PaymentEvidence; job: PaidJobScope }>
  | BaseEvent<"blocker.observed", BlockerInput>
  | BaseEvent<"run.status", LiveStatus>
  | BaseEvent<"brief.requested", RevenueBrief>;

export interface DedupeEvidence {
  rootDomain: string;
  checkedAt: string;
  gmailQueryId: string;
  closeQueryId: string;
  gmailClear: boolean;
  closeClear: boolean;
}

export interface AuditEntry {
  actor: string;
  action: string;
  sourceSystem: SourceSystem;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  evidence?: string;
  success: boolean;
  error?: string;
}

export interface FulfillmentResult {
  itemId: string;
  url: string;
  owner: string;
}
