import { createHash } from "node:crypto";
import type { DealSnapshot, PaymentEvidence, SalesStage } from "./types.js";

const ORDERED_STAGES: SalesStage[] = [
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
];

export class SafetyError extends Error {
  override name = "SafetyError";
}

export function normalizeRootDomain(input: string): string {
  const value = input.trim().toLowerCase();
  if (!value) throw new SafetyError("Company root domain is required");
  const host = value.includes("@")
    ? value.split("@").at(-1) ?? ""
    : new URL(value.includes("://") ? value : `https://${value}`).hostname;
  const normalized = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
    throw new SafetyError("Company root domain is invalid");
  }
  return normalized;
}

export function canTransitionStage(from: SalesStage, to: SalesStage): boolean {
  if (to === "Lost") return from !== "Won" && from !== "Fulfillment Handoff";
  if (from === "Lost" || from === "Fulfillment Handoff") return false;
  const fromIndex = ORDERED_STAGES.indexOf(from);
  const toIndex = ORDERED_STAGES.indexOf(to);
  return fromIndex >= 0 && toIndex === fromIndex + 1;
}

export function assertStageTransition(from: SalesStage, to: SalesStage, payment?: PaymentEvidence): void {
  if (!canTransitionStage(from, to)) {
    throw new SafetyError(`Invalid Close stage transition: ${from} -> ${to}`);
  }
  if (to === "Won") {
    if (!payment || payment.status !== "succeeded" || payment.attribution !== "exact") {
      throw new SafetyError("Won requires an exactly attributed succeeded Stripe payment");
    }
  }
}

export function assertAttributablePayment(payment: PaymentEvidence, deal: DealSnapshot, expectedAccountId: string): void {
  if (payment.stripeAccountId !== expectedAccountId) {
    throw new SafetyError("Payment came from an unapproved Stripe account");
  }
  if (payment.status !== "succeeded") throw new SafetyError("Stripe payment has not succeeded");
  if (payment.attribution !== "exact" || payment.attributedOpportunityId !== deal.opportunityId) {
    throw new SafetyError("Stripe payment attribution is ambiguous");
  }
  if (payment.amountPaidCents <= 0 || payment.totalContractCents <= 0) {
    throw new SafetyError("Payment amount is missing or invalid");
  }
  if (payment.amountPaidCents > payment.totalContractCents) {
    throw new SafetyError("Amount paid exceeds the known contract value");
  }
  if (payment.paymentKind === "unknown") throw new SafetyError("Deposit versus full payment is unclear");
  if (payment.recurring === null) throw new SafetyError("Recurring versus one-time billing is unclear");
}

export function assertDemoDeal(deal: DealSnapshot): void {
  if (!deal.email.toLowerCase().endsWith(".test")) {
    throw new SafetyError("DEMO records must use a reserved .test email domain");
  }
  if (!normalizeRootDomain(deal.rootDomain).endsWith(".test")) {
    throw new SafetyError("DEMO records must use a reserved .test company domain");
  }
  for (const evidence of deal.evidence) {
    const host = new URL(evidence.url).hostname;
    if (!host.endsWith(".test")) throw new SafetyError("DEMO evidence links must use .test hosts");
  }
}

export function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
