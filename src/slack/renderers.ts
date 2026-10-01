import type {
  BlockerInput,
  DealSnapshot,
  FulfillmentResult,
  LiveStatus,
  PaidJobScope,
  PaymentEvidence,
  RevenueBrief,
  RunLifecycle,
} from "../domain/types.js";
import type { SlackBlock, SlackMessage } from "./client.js";

const money = (cents: number, currency = "USD") => new Intl.NumberFormat("en-US", {
  style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0,
}).format(cents / 100);

const md = (text: string) => ({ type: "mrkdwn", text });
const section = (text?: string, fields?: string[]): SlackBlock => ({
  type: "section", ...(text?.trim() ? { text: md(text) } : {}), ...(fields?.length ? { fields: fields.map(md) } : {}),
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

export function withMessageMeta(message: SlackMessage, actor: string, demo: boolean): SlackMessage {
  return {
    ...message,
    blocks: [...message.blocks, context(`Actor: ${actor}`, ...(demo ? [":test_tube: *DEMO — synthetic data only*"] : []))],
  };
}

export function formatPhoenixTime(input: string | undefined): string {
  if (!input) return "Not verified";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

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
    context(`Counts: Close · as of ${formatPhoenixTime(c.asOf)}`, `Last successful run: ${formatPhoenixTime(status.lastSuccessfulRunAt)}`, `Next sprint: ${formatPhoenixTime(status.nextScheduledRunAt)}`),
    divider(),
    section("*Operators*", status.operators.slice(0, 10).map((o) => `*${o.name}*\n${o.state}${o.focus ? ` · ${o.focus}` : ""}`)),
    section("*Sender health*", status.senderHealth.map((s) => `*${s.mailbox}*\n${s.status}`)),
  ];
  if (status.topBlockers.length) blocks.push(section("*Top blockers*", status.topBlockers.slice(0, 3).map((b) => `*${b.key} · ${b.status}*\n${b.summary} · ${b.owner}`)));
  const unhealthy = status.integrations.filter((i) => i.status !== "healthy");
  blocks.push(context(unhealthy.length ? `Integration attention: ${unhealthy.map((i) => `${i.system}=${i.status}`).join(" · ")}` : "Integrations: healthy", "This message is updated in place"));
  return { text: `Qira Revenue OS is ${status.revenueOsState}; ${money(c.revenueCollectedCents, c.currency)} collected`, blocks };
}

export function renderHumanReply(deal: DealSnapshot, excerpt: string, needsTriage = false, dealHomeUrl?: string): SlackMessage {
  const blocks: SlackBlock[] = [
    header(needsTriage ? "⚠️ Reply needs triage" : "🔥 Human prospect reply"),
    section(needsTriage ? "Classification is uncertain. Review before any action." : "A real person replied. This is a high-priority revenue signal."),
    section("", dealFields(deal).slice(0, 6)),
    section(`*Latest inbound*\n> ${excerpt.slice(0, 500)}`),
    section(`*Recommended next action*\n${deal.nextAction}`),
  ];
  const actions = evidenceActions(deal);
  if (actions) blocks.push(actions);
  if (dealHomeUrl) blocks.push({ type: "actions", elements: [linkButton("Open deal home", dealHomeUrl, "open_deal_home")] });
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

export function renderMeeting(deal: DealSnapshot, dealHomeUrl?: string): SlackMessage {
  const blocks: SlackBlock[] = [
    header("📅 Meeting booked"), section("", dealFields(deal).slice(0, 6)),
    section(`*Meeting*\n${deal.meetingAt ?? "Time not verified"}\n*Prepare*\n${deal.nextAction}`),
  ];
  const actions = evidenceActions(deal);
  if (actions) blocks.push(actions);
  if (dealHomeUrl) blocks.push({ type: "actions", elements: [linkButton("Open deal home", dealHomeUrl, "open_meeting_deal_home")] });
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

export function renderFulfillmentFailed(deal: DealSnapshot, payment: PaymentEvidence, reason: string): SlackMessage {
  return {
    text: `FULFILLMENT HANDOFF FAILED: ${deal.company} — payment remains verified`,
    blocks: [
      header("FULFILLMENT HANDOFF FAILED"),
      section(`*${deal.company} is paid and Close is Won.* Payment truth is unchanged.`),
      section(undefined, [
        `*Paid*\n${money(payment.amountPaidCents, payment.currency)}`,
        `*PaymentIntent*\n${payment.paymentIntentId}`,
        `*Failure*\n${reason.slice(0, 500)}`,
        `*Next action*\nRetry the idempotent monday handoff`,
      ]),
      { type: "actions", elements: [linkButton("Open Stripe evidence", payment.dashboardUrl, "open_verified_stripe")] },
      context("Stripe verified · Close Won verified · monday handoff pending"),
    ],
  };
}

export function renderFulfillmentRecovered(deal: DealSnapshot, payment: PaymentEvidence, fulfillment: FulfillmentResult): SlackMessage {
  return {
    text: `Fulfillment handoff recovered: ${deal.company}`,
    blocks: [
      header("Fulfillment handoff recovered"),
      section(`*${deal.company}* remains paid and Won. The idempotent monday retry succeeded.`),
      section(undefined, [`*PaymentIntent*\n${payment.paymentIntentId}`, `*monday item*\n${fulfillment.itemId}`, `*Owner*\n${fulfillment.owner}`]),
      { type: "actions", elements: [linkButton("Open monday", fulfillment.url, "open_recovered_fulfillment")] },
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

export function renderDealTimeline(title: string, detail: string, deal: DealSnapshot): SlackMessage {
  return {
    text: `${title}: ${deal.company}`,
    blocks: [header(title), section(detail), context(`Close stage: ${deal.stage}`, `Next: ${deal.nextAction}`)],
  };
}

export function renderRunLogParent(date: string): SlackMessage {
  return { text: `Run log — ${date}`, blocks: [header(`Run log — ${date}`), context("START/END details stay in this daily thread; material outcomes escalate separately")] };
}

export function renderRunTimeline(kind: "started" | "ended", run: RunLifecycle): SlackMessage {
  return {
    text: `Run ${kind}: ${run.status.runId ?? "unknown"}`,
    blocks: [
      section(`*${kind === "started" ? "START" : "END"}* · \`${run.status.runId ?? "unknown"}\`\n${run.summary}`),
      context(`Human replies ${run.material.humanReplies} · Meetings ${run.material.meetings} · Payments ${run.material.payments} · New blockers ${run.material.newBlockers}`),
    ],
  };
}

export function renderRunMaterial(run: RunLifecycle): SlackMessage {
  return {
    text: `Material run outcome: ${run.summary}`,
    blocks: [header("Material revenue run outcome"), section(run.summary), section(undefined, [
      `*Human replies*\n${run.material.humanReplies}`, `*Meetings*\n${run.material.meetings}`,
      `*Payments*\n${run.material.payments}`, `*New blockers*\n${run.material.newBlockers}`,
    ])],
  };
}

export function renderSenderHealthChange(mailbox: string, kind: string): SlackMessage {
  return { text: `Sender health changed: ${mailbox}`, blocks: [header("Sender health changed"), section(`*${mailbox}* produced a ${kind}. Review current sender health before more outbound.`)] };
}

export function renderBrief(brief: RevenueBrief): SlackMessage {
  const items = [
    brief.dealsAdvanced.length ? `*Deals advanced*\n${brief.dealsAdvanced.map((x) => `• ${x}`).join("\n")}` : "",
    brief.proposalsOrPaymentRequests.length ? `*Proposal / payment*\n${brief.proposalsOrPaymentRequests.map((x) => `• ${x}`).join("\n")}` : "",
    brief.followUpsDue.length ? `*Follow-ups due*\n${brief.followUpsDue.map((x) => `• ${x}`).join("\n")}` : "",
    brief.newPipeline.length ? `*New pipeline*\n${brief.newPipeline.map((x) => `• ${x}`).join("\n")}` : "",
    brief.lostOrSuppressed.length ? `*Lost / suppressed*\n${brief.lostOrSuppressed.map((x) => `• ${x}`).join("\n")}` : "",
    brief.blockers.length ? `*Blockers*\n${brief.blockers.map((x) => `• ${x}`).join("\n")}` : "",
    `*Viktor next*\n${brief.viktorFocus}`,
  ].filter(Boolean);
  const blocks = [
    header(`${brief.period} Revenue Brief`),
    section(undefined, [`*Money collected*\n${money(brief.moneyCollectedCents, brief.currency)}`, `*Human replies*\n${brief.humanReplies}`, `*Meetings*\n${brief.meetings}`]),
    ...items.slice(0, 7).map((x) => section(x)),
    context(`Material changes only · as of ${formatPhoenixTime(brief.asOf)}`),
  ];
  return { text: `${brief.period} revenue brief — ${money(brief.moneyCollectedCents, brief.currency)} collected`, blocks };
}

export function validateSlackMessage(message: SlackMessage): void {
  if (!message.text.trim()) throw new Error("Slack fallback text is required");
  if (message.text.length > 4_000) throw new Error("Slack fallback text exceeds 4,000 characters");
  if (message.blocks.length === 0 || message.blocks.length > 50) throw new Error("Slack messages require 1–50 blocks");
  const raw = JSON.stringify(message);
  if (raw.length > 40_000) throw new Error("Slack payload is too large");
  for (const [blockIndex, block] of message.blocks.entries()) {
    const type = block.type;
    if (typeof type !== "string" || !type) throw new Error(`Block ${blockIndex} requires a type`);
    if (type === "section") {
      const blockText = block.text as { text?: unknown } | undefined;
      const fields = block.fields as Array<{ text?: unknown }> | undefined;
      if (!blockText && !fields?.length) throw new Error(`Section ${blockIndex} requires text or fields`);
      if (fields && (fields.length > 10 || fields.some((field) => typeof field.text !== "string" || !field.text.trim()))) throw new Error(`Section ${blockIndex} has invalid fields`);
    }
    if (type === "actions") {
      const elements = block.elements as unknown[] | undefined;
      if (!elements?.length || elements.length > 25) throw new Error(`Actions ${blockIndex} requires 1–25 elements`);
    }
    if (type === "context") {
      const elements = block.elements as Array<{ text?: unknown }> | undefined;
      if (!elements?.length || elements.length > 10) throw new Error(`Context ${blockIndex} requires 1–10 elements`);
    }
    const stack: unknown[] = [block];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      const object = value as Record<string, unknown>;
      if ((object.type === "mrkdwn" || object.type === "plain_text") && (typeof object.text !== "string" || !object.text.trim())) {
        throw new Error(`Block ${blockIndex} contains empty ${String(object.type)} text`);
      }
      for (const child of Object.values(object)) {
        if (Array.isArray(child)) stack.push(...child);
        else if (child && typeof child === "object") stack.push(child);
      }
    }
  }
}
