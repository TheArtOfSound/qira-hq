import type { CloseAdapter, DedupeAdapter, FulfillmentAdapter, RevenueAdapters } from "../adapters/interfaces.js";
import { assertStageTransition, normalizeRootDomain } from "../domain/safety.js";
import type { DealSnapshot, DedupeEvidence, FulfillmentResult, PaidJobScope, PaymentEvidence, PipelineCounts, SalesStage } from "../domain/types.js";
import { DEMO_DEALS } from "./fixtures.js";

export class DemoCloseAdapter implements CloseAdapter {
  readonly deals = new Map<string, DealSnapshot>(DEMO_DEALS.map((deal) => [deal.opportunityId, structuredClone(deal)]));

  async getOpportunity(opportunityId: string): Promise<DealSnapshot> {
    const deal = this.deals.get(opportunityId);
    if (!deal) throw new Error(`Demo opportunity not found: ${opportunityId}`);
    return structuredClone(deal);
  }

  async transitionStage(opportunityId: string, expectedCurrent: SalesStage, next: SalesStage): Promise<DealSnapshot> {
    const deal = await this.getOpportunity(opportunityId);
    if (deal.stage !== expectedCurrent) throw new Error(`Close compare-and-set failed: expected ${expectedCurrent}, found ${deal.stage}`);
    if (next !== "Won") assertStageTransition(deal.stage, next);
    const updated = { ...deal, stage: next };
    this.deals.set(opportunityId, updated);
    return structuredClone(updated);
  }

  async getPipelineCounts(): Promise<PipelineCounts> {
    const values = [...this.deals.values()];
    const count = (...stages: SalesStage[]) => values.filter((deal) => stages.includes(deal.stage)).length;
    return {
      qualified: count("Qualified"), contacted: count("Contacted"), replied: count("Replied"), meetings: count("Meeting Booked"),
      scoped: count("Scope Negotiation", "Price Agreed"), proposal: count("Proposal Sent", "Contract Sent"),
      paymentPending: count("Payment Link Sent"), won: count("Won", "Fulfillment Handoff"),
      revenueCollectedCents: values.filter((deal) => deal.stage === "Won" || deal.stage === "Fulfillment Handoff").reduce((sum, deal) => sum + (deal.expectedValueCents ?? 0), 0),
      currency: "USD", source: "close", asOf: new Date().toISOString(),
    };
  }
}

export class DemoDedupeAdapter implements DedupeAdapter {
  async check(rootDomain: string): Promise<DedupeEvidence> {
    const domain = normalizeRootDomain(rootDomain);
    return { rootDomain: domain, checkedAt: new Date().toISOString(), gmailQueryId: `gmail-demo:${domain}`, closeQueryId: `close-demo:${domain}`, gmailClear: true, closeClear: true };
  }
}

export class DemoFulfillmentAdapter implements FulfillmentAdapter {
  readonly jobs = new Map<string, FulfillmentResult>();
  async createOrGetPaidJob(deal: DealSnapshot, payment: PaymentEvidence, job: PaidJobScope): Promise<FulfillmentResult> {
    const existing = this.jobs.get(payment.paymentIntentId);
    if (existing) return existing;
    const created = { itemId: `monday-demo-${payment.paymentIntentId}`, url: `https://monday.example.test/items/${payment.paymentIntentId}`, owner: job.fulfillmentOwner };
    this.jobs.set(payment.paymentIntentId, created);
    return created;
  }
}

export function demoAdapters(): RevenueAdapters {
  return { dedupe: new DemoDedupeAdapter(), close: new DemoCloseAdapter(), fulfillment: new DemoFulfillmentAdapter() };
}
