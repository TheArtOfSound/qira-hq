import type { RevenueAdapters } from "../adapters/interfaces.js";
import { assertAttributablePayment, assertDemoEvent, assertStageTransition, normalizeRootDomain, SafetyError } from "../domain/safety.js";
import { SALES_STAGES, type DealSnapshot, type FulfillmentResult, type RevenueEvent, type SalesStage, type StatusInput } from "../domain/types.js";
import type { SlackClient, SlackMessage, SlackPostResult } from "../slack/client.js";
import {
  renderBlocker,
  renderBrief,
  renderDealCard,
  renderDealTimeline,
  renderFulfillmentFailed,
  renderFulfillmentRecovered,
  renderHumanReply,
  renderLiveStatus,
  renderMeeting,
  renderPaidJobReady,
  renderPaymentReview,
  renderRunLogParent,
  renderRunMaterial,
  renderRunTimeline,
  renderSenderHealthChange,
  validateSlackMessage,
  withMessageMeta,
} from "../slack/renderers.js";
import { CommandCenterStore, type SurfaceRef } from "../storage/store.js";

export interface CommandCenterConfig {
  stripeAccountId: string;
  slackWorkspaceUrl: string;
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
  retryable?: boolean;
}

export class CommandCenter {
  constructor(
    private readonly store: CommandCenterStore,
    private readonly slack: SlackClient,
    private readonly adapters: RevenueAdapters,
    private readonly config: CommandCenterConfig,
  ) {}

  async handleEvent(event: RevenueEvent): Promise<EventResult> {
    if (event.demo) assertDemoEvent(event);
    if (!this.store.beginEvent(event.id, event.type)) return { duplicate: true, outcome: "replay_suppressed", messageCount: 0 };
    try {
      const result = await this.route(event);
      this.store.finishEvent(event.id, result.retryable ? "failed" : "processed", result);
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

  async advanceStage(opportunityId: string, to: SalesStage, actor: string, demo = false): Promise<DealSnapshot> {
    const before = await this.adapters.close.getOpportunity(opportunityId);
    if (to === "Won") throw new SafetyError("Won cannot be set by a Slack button; Stripe evidence is required");
    assertStageTransition(before.stage, to);
    const after = await this.adapters.close.transitionStage(opportunityId, before.stage, to);
    if (after.stage !== to) throw new SafetyError("Close read-back did not confirm the requested stage");
    this.store.recordAudit({ actor, action: "close.stage.transition", sourceSystem: "slack", entityType: "opportunity", entityId: opportunityId, before, after, success: true });
    await this.upsertSurface("deal", opportunityId, this.config.channels.pipeline, renderDealCard(after, `${before.stage} → ${after.stage}`), `stage:${opportunityId}:${to}`, actor, demo);
    return after;
  }

  private async route(event: RevenueEvent): Promise<EventResult> {
    switch (event.type) {
      case "run.status": {
        const status = await this.canonicalStatus(event.data);
        await this.upsertSurface("live-status", "global", this.config.channels.control, renderLiveStatus(status), event.id, event.actor, event.demo);
        return { duplicate: false, outcome: "status_updated", messageCount: 1 };
      }
      case "run.started":
      case "run.ended":
        return this.handleRunLifecycle(event);
      case "reply.received":
        return this.handleReply(event);
      case "meeting.booked":
        return this.handleMeeting(event);
      case "deal.updated": {
        const current = await this.adapters.close.getOpportunity(event.data.deal.opportunityId);
        await this.upsertSurface("deal", current.opportunityId, this.config.channels.pipeline, renderDealCard(current, event.data.changed), event.id, event.actor, event.demo);
        return { duplicate: false, outcome: "deal_updated", messageCount: 1 };
      }
      case "proposal.sent":
        return this.handleDealMilestone(event, "Proposal Sent", "Proposal sent", "proposal_updated");
      case "payment.requested":
        return this.handleDealMilestone(event, "Payment Link Sent", "Payment requested", "payment_request_updated");
      case "blocker.observed": {
        const { isNew, record } = this.store.upsertBlocker(event.data, event.occurredAt);
        await this.upsertSurface("blocker", record.key, this.config.channels.alerts, renderBlocker(record, record.occurrenceCount, record.firstSeen, record.lastSeen), event.id, event.actor, event.demo);
        return { duplicate: false, outcome: isNew ? "blocker_posted" : "blocker_updated", messageCount: 1 };
      }
      case "brief.requested": {
        if (!event.data.changed) return { duplicate: false, outcome: "unchanged_brief_suppressed", messageCount: 0 };
        const totals = this.store.getSuppressionTotals(this.phoenixDate(event.occurredAt));
        const suppression = `Suppressed: ${totals.autoresponder} autoresponder · ${totals.bounce} bounce · ${totals.dsn} DSN`;
        const brief = { ...event.data, lostOrSuppressed: [suppression, ...event.data.lostOrSuppressed].slice(0, 3) };
        await this.post(this.config.channels.control, renderBrief(brief), event.id, event.actor, event.demo);
        return { duplicate: false, outcome: "brief_posted", messageCount: 1 };
      }
      case "payment.succeeded":
        return this.handlePayment(event);
    }
  }

  private async handleReply(event: Extract<RevenueEvent, { type: "reply.received" }>): Promise<EventResult> {
    const { deal, messageId, mailbox, classification } = event.data;
    const actionKey = `gmail:message:${messageId}`;
    const claim = this.store.beginBusinessAction(actionKey, "gmail.reply", deal.opportunityId, event.occurredAt);
    if (claim === "completed") return { duplicate: true, outcome: "gmail_message_replay_suppressed", messageCount: 0 };
    if (claim === "active") return { duplicate: true, outcome: "gmail_message_active", messageCount: 0 };
    try {
      if (classification === "autoresponder" || classification === "bounce" || classification === "dsn") {
        this.store.incrementSuppression(this.phoenixDate(event.occurredAt), mailbox, classification, event.occurredAt);
        let messageCount = 0;
        if ((classification === "bounce" || classification === "dsn") && event.data.senderHealthChanged) {
          await this.post(this.config.channels.alerts, renderSenderHealthChange(mailbox, classification), `${actionKey}:health`, event.actor, event.demo);
          messageCount = 1;
        }
        this.store.finishBusinessAction(actionKey, "completed", { classification });
        return { duplicate: false, outcome: `${classification}_suppressed`, messageCount };
      }
      if (classification === "unknown") {
        await this.post(this.config.channels.replies, renderHumanReply(deal, event.data.excerpt, true), actionKey, event.actor, event.demo);
        this.store.finishBusinessAction(actionKey, "completed", { classification });
        return { duplicate: false, outcome: "reply_triage_posted", messageCount: 1 };
      }

      const current = await this.adapters.close.getOpportunity(deal.opportunityId);
      let replied = current;
      if (current.stage === "Contacted") replied = await this.adapters.close.transitionStage(current.opportunityId, "Contacted", "Replied");
      else if (!this.isAtOrBeyond(current.stage, "Replied")) throw new SafetyError(`Human reply cannot reconcile Close stage ${current.stage}`);
      if (!this.isAtOrBeyond(replied.stage, "Replied")) throw new SafetyError("Close read-back did not confirm Replied");

      const home = await this.upsertSurface("deal", replied.opportunityId, this.config.channels.pipeline, renderDealCard(replied, "Verified human reply"), `${actionKey}:deal`, event.actor, event.demo);
      await this.post(this.config.channels.pipeline, renderDealTimeline("Human reply", event.data.excerpt, replied), `${actionKey}:timeline`, event.actor, event.demo, home.messageTs);
      await this.post(this.config.channels.replies, renderHumanReply(replied, event.data.excerpt, false, this.surfaceUrl(home)), actionKey, event.actor, event.demo);
      this.store.recordAudit({ actor: event.actor, action: "gmail.human_reply.reconciled", sourceSystem: "gmail", entityType: "opportunity", entityId: replied.opportunityId, before: current, after: replied, evidence: messageId, success: true });
      this.store.finishBusinessAction(actionKey, "completed", { stage: replied.stage, home });
      return { duplicate: false, outcome: "human_reply_reconciled", messageCount: 3 };
    } catch (error) {
      this.store.finishBusinessAction(actionKey, "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async handleMeeting(event: Extract<RevenueEvent, { type: "meeting.booked" }>): Promise<EventResult> {
    const deal = await this.reconcileMilestone(event.data.deal.opportunityId, "Meeting Booked");
    const home = await this.upsertSurface("deal", deal.opportunityId, this.config.channels.pipeline, renderDealCard(deal, "Meeting booked"), `${event.id}:deal`, event.actor, event.demo);
    await this.post(this.config.channels.pipeline, renderDealTimeline("Meeting booked", deal.meetingAt ?? "Calendly booking verified", deal), `${event.id}:timeline`, event.actor, event.demo, home.messageTs);
    await this.post(this.config.channels.replies, renderMeeting(deal, this.surfaceUrl(home)), event.id, event.actor, event.demo);
    return { duplicate: false, outcome: "meeting_reconciled", messageCount: 3 };
  }

  private async handleDealMilestone(
    event: Extract<RevenueEvent, { type: "proposal.sent" | "payment.requested" }>,
    target: SalesStage,
    title: string,
    outcome: string,
  ): Promise<EventResult> {
    const deal = await this.reconcileMilestone(event.data.deal.opportunityId, target);
    const home = await this.upsertSurface("deal", deal.opportunityId, this.config.channels.pipeline, renderDealCard(deal, title), `${event.id}:deal`, event.actor, event.demo);
    await this.post(this.config.channels.pipeline, renderDealTimeline(title, `Canonical Close stage is ${deal.stage}.`, deal), `${event.id}:timeline`, event.actor, event.demo, home.messageTs);
    return { duplicate: false, outcome, messageCount: 2 };
  }

  private async handleRunLifecycle(event: Extract<RevenueEvent, { type: "run.started" | "run.ended" }>): Promise<EventResult> {
    const status = await this.canonicalStatus(event.data.status);
    await this.upsertSurface("live-status", "global", this.config.channels.control, renderLiveStatus(status), `${event.id}:status`, event.actor, event.demo);
    const date = this.phoenixDate(event.occurredAt);
    const parent = await this.upsertSurface("run-log", date, this.config.channels.control, renderRunLogParent(date), `run-log:${date}`, event.actor, event.demo);
    await this.post(this.config.channels.control, renderRunTimeline(event.type === "run.started" ? "started" : "ended", event.data), `${event.id}:timeline`, event.actor, event.demo, parent.messageTs);
    let messageCount = 3;
    const material = event.type === "run.ended" && (
      event.data.material.humanReplies > 0 || event.data.material.meetings > 0 || event.data.material.payments > 0 ||
      event.data.material.newBlockers > 0 || event.data.material.senderHealthChanged || event.data.material.stalledMinutes > 45
    );
    if (material) {
      await this.post(this.config.channels.alerts, renderRunMaterial(event.data), `${event.id}:material`, event.actor, event.demo);
      messageCount += 1;
    }
    return { duplicate: false, outcome: material ? "run_material_escalated" : "run_lifecycle_suppressed", messageCount };
  }

  private async handlePayment(event: Extract<RevenueEvent, { type: "payment.succeeded" }>): Promise<EventResult> {
    const { deal, payment, job } = event.data;
    try {
      assertAttributablePayment(payment, deal, this.config.stripeAccountId);
      if (!job.scope.length || !job.deliverables.length || !job.deadline || !job.fulfillmentOwner) throw new SafetyError("Agreement scope, deliverables, deadline, and fulfillment owner are required");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.post(this.config.channels.alerts, renderPaymentReview(deal, payment, reason), `stripe:${payment.paymentIntentId}:review`, event.actor, event.demo);
      this.store.recordAudit({ actor: event.actor, action: "payment.review_required", sourceSystem: "stripe", entityType: "opportunity", entityId: deal.opportunityId, before: deal, after: deal, evidence: payment.paymentIntentId, success: false, error: reason });
      return { duplicate: false, outcome: "payment_review_required", messageCount: 1 };
    }

    const claimed = this.store.claimPayment(payment.paymentIntentId, deal.opportunityId, event.occurredAt);
    if (claimed.conflict) {
      const reason = "PaymentIntent is already attributed to a different opportunity";
      await this.post(this.config.channels.alerts, renderPaymentReview(deal, payment, reason), `stripe:${payment.paymentIntentId}:conflict`, event.actor, event.demo);
      return { duplicate: false, outcome: "payment_review_required", messageCount: 1 };
    }
    if (claimed.record.fulfillmentStatus === "completed" && this.store.getSurface("payment-win", payment.paymentIntentId)) {
      return { duplicate: true, outcome: "payment_intent_replay_suppressed", messageCount: 0 };
    }

    let current = await this.adapters.close.getOpportunity(deal.opportunityId);
    if (normalizeRootDomain(current.rootDomain) !== normalizeRootDomain(deal.rootDomain)) {
      const reason = "Close company identity conflicts with payment attribution";
      await this.post(this.config.channels.alerts, renderPaymentReview(deal, payment, reason), `stripe:${payment.paymentIntentId}:identity`, event.actor, event.demo);
      return { duplicate: false, outcome: "payment_review_required", messageCount: 1 };
    }
    if (!claimed.record.closeWonAt) {
      if (current.stage === "Won" || current.stage === "Fulfillment Handoff") {
        const reason = "Close is already Won without this PaymentIntent's durable attribution record";
        await this.post(this.config.channels.alerts, renderPaymentReview(current, payment, reason), `stripe:${payment.paymentIntentId}:preexisting-won`, event.actor, event.demo);
        return { duplicate: false, outcome: "payment_review_required", messageCount: 1 };
      }
      assertStageTransition(current.stage, "Won", payment);
      current = await this.adapters.close.transitionStage(current.opportunityId, current.stage, "Won");
      if (current.stage !== "Won") throw new SafetyError("Close read-back did not confirm Won");
      this.store.markPaymentWon(payment.paymentIntentId);
    } else if (current.stage !== "Won" && current.stage !== "Fulfillment Handoff") {
      throw new SafetyError("Durable payment record says Won but Close no longer agrees");
    }

    const recoveringFulfillment = claimed.record.fulfillmentStatus === "failed";
    let fulfillment = claimed.record.fulfillmentJson as FulfillmentResult | undefined;
    if (!fulfillment) {
      try {
        fulfillment = await this.adapters.fulfillment.createOrGetPaidJob(current, payment, job);
        this.store.markFulfillment(payment.paymentIntentId, "completed", fulfillment);
        if (recoveringFulfillment && this.store.getSurface("fulfillment-failure", payment.paymentIntentId)) {
          await this.upsertSurface("fulfillment-failure", payment.paymentIntentId, this.config.channels.alerts, renderFulfillmentRecovered(current, payment, fulfillment), `stripe:${payment.paymentIntentId}:handoff-recovered`, event.actor, event.demo);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.store.markFulfillment(payment.paymentIntentId, "failed", reason);
        await this.upsertSurface("fulfillment-failure", payment.paymentIntentId, this.config.channels.alerts, renderFulfillmentFailed(current, payment, reason), `stripe:${payment.paymentIntentId}:handoff-failed`, event.actor, event.demo);
        this.store.recordAudit({ actor: event.actor, action: "fulfillment.handoff_failed", sourceSystem: "monday", entityType: "opportunity", entityId: deal.opportunityId, before: current, after: current, evidence: payment.paymentIntentId, success: false, error: reason });
        return { duplicate: false, outcome: "fulfillment_handoff_failed", messageCount: 1, retryable: true };
      }
    }

    await this.upsertSurface("deal", current.opportunityId, this.config.channels.pipeline, renderDealCard(current, "Verified payment"), `stripe:${payment.paymentIntentId}:deal`, event.actor, event.demo);
    await this.upsertSurface("payment-win", payment.paymentIntentId, this.config.channels.wins, renderPaidJobReady(current, payment, job, fulfillment), `stripe:${payment.paymentIntentId}:paid`, event.actor, event.demo);
    this.store.recordAudit({ actor: event.actor, action: "payment.confirmed_and_handoff", sourceSystem: "stripe", entityType: "opportunity", entityId: deal.opportunityId, before: deal, after: { won: current, fulfillment }, evidence: payment.paymentIntentId, success: true });
    return { duplicate: false, outcome: "paid_job_ready", messageCount: 2 };
  }

  private async canonicalStatus(input: StatusInput) {
    return { ...input, counts: await this.adapters.close.getPipelineCounts() };
  }

  private async reconcileMilestone(opportunityId: string, target: SalesStage): Promise<DealSnapshot> {
    const current = await this.adapters.close.getOpportunity(opportunityId);
    if (current.stage === target || this.isAtOrBeyond(current.stage, target)) return current;
    assertStageTransition(current.stage, target);
    const updated = await this.adapters.close.transitionStage(opportunityId, current.stage, target);
    if (updated.stage !== target) throw new SafetyError(`Close read-back did not confirm ${target}`);
    return updated;
  }

  private isAtOrBeyond(stage: SalesStage, target: SalesStage): boolean {
    if (stage === "Lost") return false;
    return SALES_STAGES.indexOf(stage) >= SALES_STAGES.indexOf(target);
  }

  private phoenixDate(value: string): string {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  private surfaceUrl(ref: SurfaceRef): string {
    return `${this.config.slackWorkspaceUrl.replace(/\/$/, "")}/archives/${ref.channelId}/p${ref.messageTs.replace(".", "")}`;
  }

  private async post(channelId: string, message: SlackMessage, key: string, actor: string, demo: boolean, threadTs?: string): Promise<SlackPostResult> {
    const decorated = withMessageMeta(message, actor, demo);
    validateSlackMessage(decorated);
    return this.slack.post(channelId, decorated, key, threadTs);
  }

  private async upsertSurface(kind: string, entityId: string, channelId: string, message: SlackMessage, key: string, actor: string, demo: boolean): Promise<SurfaceRef> {
    const decorated = withMessageMeta(message, actor, demo);
    validateSlackMessage(decorated);
    const current = this.store.getSurface(kind, entityId);
    if (current) {
      await this.slack.update(current.channelId, current.messageTs, decorated);
      return current;
    }
    const created = await this.slack.post(channelId, decorated, key);
    this.store.saveSurface(kind, entityId, created);
    return created;
  }
}
