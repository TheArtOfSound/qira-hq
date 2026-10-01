import type {
  BlockerInput,
  DealSnapshot,
  FulfillmentResult,
  LiveStatus,
  PaidJobScope,
  PaymentEvidence,
  RevenueBrief,
} from "../domain/types.js";
import type { SlackBlock, SlackMessage } from "./client.js";

const money = (cents: number, currency = "USD") => new Intl.NumberFormat("en-US", {
  style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0,
}).format(cents / 100);

const md = (text: string) => ({ type: "mrkdwn", text });
const section = (text: string, fields?: string[]): SlackBlock => ({
  type: "section", text: md(text), ...(fields?.length ? { fields: fields.map(md) } : {}),
});
const context = (...items: string[]): SlackBlock => ({ type: "context", elements: items.map(md) });
const divider = (): SlackBlock => ({ type: "divider" });
const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text, emoji: true } });
const linkButton = (text: string, url: string, actionId: string): Record<string, unknown> => ({
  type: "button", text: { type: "plain_text", text, emoji: true }, url, action_id: actionId,
});
const actionButton = (text: string, actionId: string, value: string, style?: "primary" | "danger"): Record<string, unknown> => ({
  type: "button", text: { type: "plain_text", text, emoji: true }, action_id: actionId, value, ...(style ? { style } : {}),
});

function evidenceActions(deal: DealSnapshot): SlackBlock | undefined {
  const elements = deal.evidence.slice(0, 5).map((item, index) => linkButton(item.label, item.url, `open_evidence_${index}`));
  return elements.length ? { type: "actions", elements } : undefined;
}

function dealFields(deal: DealSnapshot): string[] {
  return [
    `*Company*\n${deal.company}`,
    `*Contact*\n${deal.contactName}${deal.contactRole ? ` · ${deal.contactRole}` : ""}`,
    `*Owner*\n${deal.owner}`,
    `*Close stage*\n${deal.stage}${deal.daysInStage === undefined ? "" : ` · ${deal.daysInStage}d`}`,
    `*Offer*\n${deal.offer}`,
    `*Value*\n${deal.expectedValueCents === undefined ? "Not set" : money(deal.expectedValueCents, deal.currency)}`,
    `*Next action*\n${deal.nextAction}`,
    `*Due*\n${deal.nextFollowUpAt ?? "Not set"}`,
  ];
}

function nextStage(stage: DealSnapshot["stage"]): DealSnapshot["stage"] | undefined {
  const order: DealSnapshot["stage"][] = ["Qualified", "Contacted", "Replied", "Meeting Booked", "Scope Negotiation", "Price Agreed", "Proposal Sent", "Contract Sent", "Payment Link Sent"];
  const index = order.indexOf(stage);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : undefined;
}

export function renderLiveStatus(status: LiveStatus): SlackMessage {
  const c = status.counts;
  const stateEmoji = status.revenueOsState === "running" ? ":large_green_circle:" : status.revenueOsState === "stalled" ? ":red_circle:" : status.revenueOsState === "paused" ? ":double_vertical_bar:" : ":white_circle:";
  const blocks: SlackBlock[] = [
    header("Qira Revenue Command Center"),
    section(`${stateEmoji} *Revenue OS: ${status.revenueOsState.toUpperCase()}*${status.runId ? ` · \`${status.runId}\`` : ""}${status.runAgeMinutes === undefined ? "" : ` · ${status.runAgeMinutes}m`}`),
    section("*Pipeline — Close is canonical*", [
      `*Qualified* ${c.qualified}\n*Contacted* ${c.contacted}`,
      `*Replied* ${c.replied}\n*Meetings* ${c.meetings}`,
      `*Scoped* ${c.scoped}\n*Proposal* ${c.proposal}`,
      `*Payment pending* ${c.paymentPending}\n*Won* ${c.won}`,
    ]),
    section(`:moneybag: *Revenue collected:* ${money(c.revenueCollectedCents, c.currency)}`),
    context(`Counts: Close · as of ${c.asOf}`, `Last successful run: ${status.lastSuccessfulRunAt ?? "Not verified"}`, `Next sprint: ${status.nextScheduledRunAt ?? "Not scheduled"}`),
    divider(),
    section("*Operators*", status.operators.slice(0, 10).map((o) => `*${o.name}*\n${o.state}${o.focus ? ` · ${o.focus}` : ""}`)),
    section("*Sender health*", status.senderHealth.map((s) => `*${s.mailbox}*\n${s.status}`)),
  ];
  if (status.topBlockers.length) blocks.push(section("*Top blockers*", status.topBlockers.slice(0, 3).map((b) => `*${b.key} · ${b.status}*\n${b.summary} · ${b.owner}`)));
  const unhealthy = status.integrations.filter((i) => i.status !== "healthy");
  blocks.push(context(unhealthy.length ? `Integration attention: ${unhealthy.map((i) => `${i.system}=${i.status}`).join(" · ")}` : "Integrations: healthy", "This message is updated in place"));
  return { text: `Qira Revenue OS is ${status.revenueOsState}; ${money(c.revenueCollectedCents, c.currency)} collected`, blocks };
}

export function renderHumanReply(deal: DealSnapshot, excerpt: string, needsTriage = false): SlackMessage {
  const blocks: SlackBlock[] = [
    header(needsTriage ? "⚠️ Reply needs triage" : "🔥 Human prospect reply"),
    section(needsTriage ? "Classification is uncertain. Review before any action." : "A real person replied. This is a high-priority revenue signal."),
    section("", dealFields(deal).slice(0, 6)),
    section(`*Latest inbound*\n> ${excerpt.slice(0, 500)}`),
    section(`*Recommended next action*\n${deal.nextAction}`),
  ];
  const actions = evidenceActions(deal);
  if (actions) blocks.push(actions);
  return { text: `${needsTriage ? "Reply needs triage" : "Human reply"}: ${deal.company} — ${deal.nextAction}`, blocks };
}

export function renderDealCard(deal: DealSnapshot, changed?: string): SlackMessage {
  const encoded = JSON.stringify({ opportunityId: deal.opportunityId, rootDomain: deal.rootDomain });
  const advance = nextStage(deal.stage);
  const blocks: SlackBlock[] = [
    header(`Deal · ${deal.company}`),
    ...(changed ? [context(`Changed: ${changed}`)] : []),
    section("", dealFields(deal)),
    ...(deal.lastInboundExcerpt ? [section(`*Latest inbound*\n> ${deal.lastInboundExcerpt.slice(0, 500)}`)] : []),
    context(`Dedupe: ${deal.dedupeCheckedAt ?? "not verified"}`, `Opt-out: ${deal.optOut ? "YES — no outreach" : "no"}`, `Identity ambiguity: ${deal.identityAmbiguous ? "YES — blocked" : "no"}`),
    { type: "actions", elements: [
      actionButton("Claim", "claim_prospect", encoded, "primary"),
      actionButton("Release", "release_prospect", encoded),
      ...(advance ? [actionButton(`→ ${advance}`, "advance_stage", JSON.stringify({ opportunityId: deal.opportunityId, to: advance }))] : []),
      actionButton("Raise blocker", "raise_blocker", encoded),
      ...deal.evidence.slice(0, advance ? 1 : 2).map((e, i) => linkButton(e.label, e.url, `deal_evidence_${i}`)),
    ] },
    { type: "actions", elements: [
      actionButton("Mark Lost", "mark_lost", JSON.stringify({ opportunityId: deal.opportunityId, to: "Lost" }), "danger"),
      ...deal.evidence.slice(advance ? 1 : 2, 4).map((e, i) => linkButton(e.label, e.url, `deal_more_evidence_${i}`)),
    ] },
    context("Stage buttons always write Close first and refresh this card from the Close read-back. Won has no manual button."),
  ];
  return { text: `Deal ${deal.company}: ${deal.stage} — ${deal.nextAction}`, blocks };
}

export function renderMeeting(deal: DealSnapshot): SlackMessage {
  const blocks: SlackBlock[] = [
    header("📅 Meeting booked"), section("", dealFields(deal).slice(0, 6)),
    section(`*Meeting*\n${deal.meetingAt ?? "Time not verified"}\n*Prepare*\n${deal.nextAction}`),
  ];
  const actions = evidenceActions(deal);
  if (actions) blocks.push(actions);
  return { text: `Meeting booked: ${deal.company} — ${deal.meetingAt ?? "time pending"}`, blocks };
}

export function renderBlocker(blocker: BlockerInput, occurrenceCount: number, firstSeen: string, lastSeen: string): SlackMessage {
  return {
    text: `Blocker ${blocker.key}: ${blocker.businessImpact}`,
    blocks: [
      header("🚨 Revenue blocker"),
      section(`*${blocker.key} · ${blocker.status}*`, [
        `*System / action*\n${blocker.system} · ${blocker.action}`,
        `*Owner*\n${blocker.owner}`,
        `*Business impact*\n${blocker.businessImpact}`,
        `*Revenue impact*\n${blocker.revenueImpact}`,
      ]),
      section(`*Exact failure*\n\`${blocker.exactFailure.slice(0, 1000)}\``),
      section(`*Smallest fix*\n${blocker.smallestFix}`),
      { type: "actions", elements: [linkButton("View evidence", blocker.evidence.url, "open_blocker_evidence")] },
      context(`First: ${firstSeen}`, `Last: ${lastSeen}`, `Occurrences: ${occurrenceCount}`),
    ],
  };
}

export function renderPaymentReview(deal: DealSnapshot, payment: PaymentEvidence, reason: string): SlackMessage {
  return {
    text: `Payment needs review: ${deal.company} — ${reason}`,
    blocks: [
      header("⚠️ Payment needs review"),
      section(`*${deal.company}* requires operator review. Slack does not assume or display Won without verified Close read-back.`),
      section("", [
        `*Amount observed*\n${money(payment.amountPaidCents, payment.currency)}`,
        `*Stripe status*\n${payment.status}`,
        `*Attribution*\n${payment.attribution}`,
        `*Payment kind*\n${payment.paymentKind}`,
      ]),
      section(`*Why blocked*\n${reason}`),
      { type: "actions", elements: [linkButton("Open Stripe evidence", payment.dashboardUrl, "open_stripe_review")] },
    ],
  };
}

export function renderPaidJobReady(deal: DealSnapshot, payment: PaymentEvidence, job: PaidJobScope, fulfillment: FulfillmentResult): SlackMessage {
  const balance = payment.totalContractCents - payment.amountPaidCents;
  const blocks: SlackBlock[] = [
    header("💰 PAID JOB READY"),
    section(`*${deal.company}* · *${money(payment.amountPaidCents, payment.currency)} paid*`, [
      `*Customer*\n${deal.contactName}\n${deal.email}${deal.phone ? ` · ${deal.phone}` : ""}`,
      `*Sold*\n${deal.offer}`,
      `*Money*\nTotal ${money(payment.totalContractCents, payment.currency)}\nPaid ${money(payment.amountPaidCents, payment.currency)}\nBalance ${money(balance, payment.currency)}`,
      `*Deadline*\n${job.deadline}${job.kickoffBy ? `\nKickoff by ${job.kickoffBy}` : ""}`,
    ]),
    section(`*Scope*\n${job.scope.map((x) => `• ${x}`).join("\n")}`),
    section(`*Out of scope*\n${job.outOfScope.map((x) => `• ${x}`).join("\n") || "None recorded"}`),
    section(`*Deliverables / acceptance*\n${job.deliverables.map((d) => `☐ *${d.name}* — ${d.acceptance}`).join("\n")}`),
    section(`*Needed from client*\n${job.clientNeeds.map((x) => `• ${x}`).join("\n") || "Nothing recorded"}`),
    section("", [`*Fulfillment owner*\n${fulfillment.owner}`, `*Sold by*\n${deal.owner}`]),
    { type: "actions", elements: [
      linkButton("Open monday", fulfillment.url, "open_fulfillment"),
      ...deal.evidence.slice(0, 3).map((e, i) => linkButton(e.label, e.url, `paid_evidence_${i}`)),
      linkButton("Open Stripe", payment.dashboardUrl, "open_stripe"),
    ] },
    context(`Stripe ${payment.paymentIntentId} · succeeded ${payment.succeededAt ?? "time unavailable"}`, `Close → Won verified`, `monday ${fulfillment.itemId}`),
  ];
  return { text: `PAID JOB READY: ${deal.company} — ${money(payment.amountPaidCents, payment.currency)} paid`, blocks };
}

export function renderStageEvent(title: string, deal: DealSnapshot): SlackMessage {
  const blocks: SlackBlock[] = [header(title), section("", dealFields(deal).slice(0, 6)), section(`*Next action*\n${deal.nextAction}`)];
  const actions = evidenceActions(deal);
  if (actions) blocks.push(actions);
  return { text: `${title}: ${deal.company} — ${deal.stage}`, blocks };
}

export function renderBrief(brief: RevenueBrief): SlackMessage {
  const items = [
    `*Money collected* ${money(brief.moneyCollectedCents, brief.currency)}`,
    `*Human replies* ${brief.humanReplies}`,
    `*Meetings* ${brief.meetings}`,
    brief.dealsAdvanced.length ? `*Deals advanced*\n${brief.dealsAdvanced.map((x) => `• ${x}`).join("\n")}` : "",
    brief.proposalsOrPaymentRequests.length ? `*Proposal / payment*\n${brief.proposalsOrPaymentRequests.map((x) => `• ${x}`).join("\n")}` : "",
    brief.followUpsDue.length ? `*Follow-ups due*\n${brief.followUpsDue.map((x) => `• ${x}`).join("\n")}` : "",
    brief.newPipeline.length ? `*New pipeline*\n${brief.newPipeline.map((x) => `• ${x}`).join("\n")}` : "",
    brief.lostOrSuppressed.length ? `*Lost / suppressed*\n${brief.lostOrSuppressed.map((x) => `• ${x}`).join("\n")}` : "",
    brief.blockers.length ? `*Blockers*\n${brief.blockers.map((x) => `• ${x}`).join("\n")}` : "",
    `*Viktor next*\n${brief.viktorFocus}`,
  ].filter(Boolean);
  return { text: `${brief.period} revenue brief — ${money(brief.moneyCollectedCents, brief.currency)} collected`, blocks: [header(`${brief.period} Revenue Brief`), ...items.map((x) => section(x)), context(`Material changes only · as of ${brief.asOf}`)] };
}

export function validateSlackMessage(message: SlackMessage): void {
  if (!message.text.trim()) throw new Error("Slack fallback text is required");
  if (message.text.length > 4_000) throw new Error("Slack fallback text exceeds 4,000 characters");
  if (message.blocks.length === 0 || message.blocks.length > 50) throw new Error("Slack messages require 1–50 blocks");
  const raw = JSON.stringify(message);
  if (raw.length > 40_000) throw new Error("Slack payload is too large");
}
