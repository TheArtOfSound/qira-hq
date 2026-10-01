import type {
  DealSnapshot,
  DedupeEvidence,
  FulfillmentResult,
  PaidJobScope,
  PaymentEvidence,
  PipelineCounts,
  SalesStage,
} from "../domain/types.js";

export interface DedupeAdapter {
  check(rootDomain: string): Promise<DedupeEvidence>;
}

export interface CloseAdapter {
  getOpportunity(opportunityId: string): Promise<DealSnapshot>;
  transitionStage(opportunityId: string, expectedCurrent: SalesStage, next: SalesStage): Promise<DealSnapshot>;
  getPipelineCounts(): Promise<PipelineCounts>;
}

export interface FulfillmentAdapter {
  createOrGetPaidJob(deal: DealSnapshot, payment: PaymentEvidence, job: PaidJobScope): Promise<FulfillmentResult>;
}

export interface RevenueAdapters {
  dedupe: DedupeAdapter;
  close: CloseAdapter;
  fulfillment: FulfillmentAdapter;
}

export class UnconfiguredAdapterError extends Error {
  override name = "UnconfiguredAdapterError";
}

export function unconfiguredAdapters(): RevenueAdapters {
  const fail = async (): Promise<never> => {
    throw new UnconfiguredAdapterError("Live integration adapter is not configured; operation failed closed");
  };
  return {
    dedupe: { check: fail },
    close: { getOpportunity: fail, transitionStage: fail, getPipelineCounts: fail },
    fulfillment: { createOrGetPaidJob: fail },
  };
}
