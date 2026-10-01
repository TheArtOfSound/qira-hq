import type { RevenueAdapters } from "../adapters/interfaces.js";
import { assertAttributablePayment, assertDemoDeal, assertStageTransition, normalizeRootDomain, SafetyError } from "../domain/safety.js";
import type { DealSnapshot, RevenueEvent, SalesStage } from "../domain/types.js";
import type { SlackClient, SlackMessage } from "../slack/client.js";
import {
  renderBlocker,
  renderBrief,
  renderDealCard,
  renderHumanReply,
  renderLiveStatus,
  renderMeeting,
  renderPaidJobReady,
  renderPaymentReview,
  renderStageEvent,
  validateSlackMessage,
} from "../slack/renderers.js";
import { CommandCenterStore } from "../storage/store.js";

export interface CommandCenterConfig {
  stripeAccountId: string;
  channels: {
    control: string;
    replies: string;
    pipeline: string;
    alerts: string;
    wins: string;
  };
}

export interface EventResult {
  duplicate: boolean;
  outcome: string;
  messageCount: number;
}

export class CommandCenter {
  constructor(
    private readonly store: CommandCenterStore,
    private readonly slack: SlackClient,
    private readonly adapters: RevenueAdapters,
    private readonly config: CommandCenterConfig,
  ) {}

  async handleEvent(event: RevenueEvent): Promise<EventResult> {
    if (event.demo && "deal" in event.data) assertDemoDeal(event.data.deal);
    if (!this.store.beginEvent(event.id, event.type)) return { duplicate: true, outcome: "replay_suppressed", messageCount: 0 };
    try {
      const result = await this.route(event);
      this.store.finishEvent(event.id, "processed", result);
      return result;
    } catch (error) {
      this.store.finishEvent(event.id, "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async claimProspect(opportunityId: string, actor: string, expiresAt: string): Promise<{ claimed: boolean; owner: string }> {
    const deal = await this.adapters.close.getOpportunity(opportunityId);
    if (deal.optOut) throw new SafetyError("Prospect has an opt-out flag");
    if (deal.identityAmbiguous) throw new SafetyError("Company identity is ambiguous");
    const dedupe = await this.adapters.dedupe.check(deal.rootDomain);
    const before = this.store.getOwnership(deal.rootDomain) ?? null;
    const result = this.store.claimProspect({ company: deal.company, rootDomain: deal.rootDomain, owner: actor, expiresAt, dedupe });
    this.store.recordAudit({
      actor, action: "prospect.claim", sourceSystem: "slack", entityType: "company", entityId: normalizeRootDomain(deal.rootDomain),
      before, after: result.record, evidence: `${dedupe.gmailQueryId};${dedupe.closeQueryId}`, success: result.claimed,
      ...(result.claimed ? {} : { error: `Already owned by ${result.record.owner}` }),
    });
    return { claimed: result.claimed, owner: result.record.owner };
  }

  releaseProspect(rootDomain: string, actor: string): boolean {
    const before = this.store.getOwnership(rootDomain) ?? null;
    const released = this.store.releaseProspect(rootDomain, actor);
    this.store.recordAudit({
      actor, action: "prospect.release", sourceSystem: "slack", entityType: "company", entityId: normalizeRootDomain(rootDomain),
      before, after: this.store.getOwnership(rootDomain) ?? null, success: released,
      ...(released ? {} : { error: "Only the active owner may release a prospect" }),
    });
    return released;
  }

  async advanceStage(opportunityId: string, to: SalesStage, actor: string): Promise<DealSnapshot> {
    const before = await this.adapters.close.getOpportunity(opportunityId);
    if (to === "Won") throw new SafetyError("Won cannot be set by a Slack button; Stripe evidence is required");
    assertStageTransition(before.stage, to);
    const after = await this.adapters.close.transitionStage(opportunityId, before.stage, to);
    if (after.stage !== to) throw new SafetyError("Close read-back did not confirm the requested stage");
    this.store.recordAudit({ actor, action: "close.stage.transition", sourceSystem: "slack", entityType: "opportunity", entityId: opportunityId, before, after, success: true });
    await this.upsertSurface("deal", opportunityId, this.config.channels.pipeline, renderDealCard(after, `${before.stage} → ${after.stage}`), `stage:${opportunityId}:${to}`);
    return after;
  }

  private async route(event: RevenueEvent): Promise<EventResult> {
    switch (event.type) {
      case "run.status":
        await this.upsertSurface("live-status", "global", this.config.channels.control, renderLiveStatus(event.data), event.id);
        return { duplicate: false, outcome: "status_updated", messageCount: 1 };
      case "reply.received":
        if (event.data.classification === "autoresponder" || event.data.classification === "bounce") {
          return { duplicate: false, outcome: `${event.data.classification}_suppressed`, messageCount: 0 };
        }
        await this.post(this.config.channels.replies, renderHumanReply(event.data.deal, event.data.excerpt, event.data.classification === "unknown"), event.id);
        return { duplicate: false, outcome: event.data.classification === "unknown" ? "reply_triage_posted" : "human_reply_posted", messageCount: 1 };
      case "meeting.booked":
        await this.post(this.config.channels.replies, renderMeeting(event.data.deal), event.id);
        await this.upsertSurface("deal", event.data.deal.opportunityId, this.config.channels.pipeline, renderDealCard(event.data.deal, "Meeting booked"), `${event.id}:deal`);
        return { duplicate: false, outcome: "meeting_posted", messageCount: 2 };
      case "deal.updated":
        await this.upsertSurface("deal", event.data.deal.opportunityId, this.config.channels.pipeline, renderDealCard(event.data.deal, event.data.changed), event.id);
        return { duplicate: false, outcome: "deal_updated", messageCount: 1 };
      case "proposal.sent":
        await this.post(this.config.channels.pipeline, renderStageEvent("📄 Proposal sent", event.data.deal), event.id);
        return { duplicate: false, outcome: "proposal_posted", messageCount: 1 };
      case "payment.requested":
        await this.post(this.config.channels.pipeline, renderStageEvent("💳 Payment requested", event.data.deal), event.id);
        return { duplicate: false, outcome: "payment_request_posted", messageCount: 1 };
      case "blocker.observed": { 
        const { isNew, record } = this.store.upsertBlocker(event.data, event.occurredAt);
        await this.upsertSurface("blocker", record.key, this.config.channels.alerts, renderBlocker(record, record.occurrenceCount, record.firstSeen, record.lastSeen), event.id);
        return { duplicate: false, outcome: isNew ? "blocker_posted" : "blocker_updated", messageCount: 1 };
      }
      case "brief.requested":
        if (!event.data.changed) return { duplicate: false, outcome: "unchanged_brief_suppressed", messageCount: 0 };
        await this.post(this.config.channels.control, renderBrief(event.data), event.id);
        return { duplicate: false, outcome: "brief_posted", messageCount: 1 };
      case "payment.succeeded":
        return this.handlePayment(event);
    }
  }

  private async handlePayment(event: Extract<RevenueEvent, { type: "payment.succeeded" }>): Promise<EventResult> {
    const { deal, payment, job } = event.data;
    try {
      assertAttributablePayment(payment, deal, this.config.stripeAccountId);
      if (!job.scope.length || !job.deliverables.length || !job.deadline || !job.fulfillmentOwner) {
        throw new SafetyError("Agreement scope, deliverables, deadline, and fulfillment owner are required");
      }
      const current = await this.adapters.close.getOpportunity(deal.opportunityId);
      if (normalizeRootDomain(current.rootDomain) !== normalizeRootDomain(deal.rootDomain)) throw new SafetyError("Close company identity conflicts with payment attribution");
      assertStageTransition(current.stage, "Won", payment);
      const won = await this.adapters.close.transitionStage(current.opportunityId, current.stage, "Won");
      if (won.stage !== "Won") throw new SafetyError("Close read-back did not confirm Won");
      const fulfillment = await this.adapters.fulfillment.createOrGetPaidJob(won, payment, job);
      await this.post(this.config.channels.wins, renderPaidJobReady(won, payment, job, fulfillment), event.id);
      this.store.recordAudit({ actor: "system", action: "payment.confirmed_and_handoff", sourceSystem: "stripe", entityType: "opportunity", entityId: deal.opportunityId, before: current, after: { won, fulfillment }, evidence: payment.paymentIntentId, success: true });
      return { duplicate: false, outcome: "paid_job_ready", messageCount: 1 };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.post(this.config.channels.alerts, renderPaymentReview(deal, payment, reason), `${event.id}:review`);
      this.store.recordAudit({ actor: "system", action: "payment.review_required", sourceSystem: "stripe", entityType: "opportunity", entityId: deal.opportunityId, before: deal, after: deal, evidence: payment.paymentIntentId, success: false, error: reason });
      return { duplicate: false, outcome: "payment_review_required", messageCount: 1 };
    }
  }

  private async post(channelId: string, message: SlackMessage, key: string): Promise<void> {
    validateSlackMessage(message);
    await this.slack.post(channelId, message, key);
  }

  private async upsertSurface(kind: string, entityId: string, channelId: string, message: SlackMessage, key: string): Promise<void> {
    validateSlackMessage(message);
    const current = this.store.getSurface(kind, entityId);
    if (current) {
      await this.slack.update(current.channelId, current.messageTs, message);
      return;
    }
    const created = await this.slack.post(channelId, message, key);
    this.store.saveSurface(kind, entityId, created);
  }
}
