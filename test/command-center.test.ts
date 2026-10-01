import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { demoAdapters, DemoCloseAdapter, DemoDedupeAdapter, DemoFulfillmentAdapter } from "../src/demo/adapters.js";
import { DEMO_EVENTS } from "../src/demo/fixtures.js";
import type { DealSnapshot, FulfillmentResult, PaidJobScope, PaymentEvidence } from "../src/domain/types.js";
import { CommandCenter } from "../src/service/command-center.js";
import { MemorySlackClient, type SlackMessage, type SlackPostResult } from "../src/slack/client.js";
import { validateSlackMessage } from "../src/slack/renderers.js";
import { CommandCenterStore } from "../src/storage/store.js";

const config = loadConfig({ DEMO_MODE: "true", DATABASE_PATH: ":memory:" });

const harness = () => {
  const store = new CommandCenterStore(":memory:");
  const slack = new MemorySlackClient();
  const adapters = demoAdapters();
  const center = new CommandCenter(store, slack, adapters, config);
  return { store, slack, adapters, center };
};

class FailOnceSlackClient extends MemorySlackClient {
  failed = false;
  override async post(channelId: string, message: SlackMessage, key: string, threadTs?: string): Promise<SlackPostResult> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("synthetic Slack 500");
    }
    return super.post(channelId, message, key, threadTs);
  }
}

class FailOnceFulfillmentAdapter extends DemoFulfillmentAdapter {
  calls = 0;
  override async createOrGetPaidJob(deal: DealSnapshot, payment: PaymentEvidence, job: PaidJobScope): Promise<FulfillmentResult> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("synthetic monday timeout");
    return super.createOrGetPaidJob(deal, payment, job);
  }
}

test("autoresponder and bounce suppression persist tallies without hot-inbox posts", async () => {
  const { store, slack, center } = harness();
  const autoresponder = DEMO_EVENTS.autoresponder;
  const bounce = DEMO_EVENTS.bounce;
  assert(autoresponder?.type === "reply.received" && bounce?.type === "reply.received");
  await center.handleEvent(structuredClone(autoresponder));
  await center.handleEvent(structuredClone(bounce));
  const duplicate = structuredClone(bounce);
  duplicate.id = "different-ingestion-same-bounce";
  await center.handleEvent(duplicate);
  assert.deepEqual(store.getSuppressionTotals("2026-10-01"), { autoresponder: 1, bounce: 1, dsn: 0 });
  assert.equal(slack.posts.length, 0);
  store.close();
});

test("human reply advances Close to Replied, updates deal home, and dedupes on Gmail message ID", async () => {
  const { store, slack, adapters, center } = harness();
  const event = DEMO_EVENTS["human-reply"];
  assert(event?.type === "reply.received");
  const first = await center.handleEvent(structuredClone(event));
  const duplicate = structuredClone(event);
  duplicate.id = "different-ingestion-same-gmail-message";
  const replay = await center.handleEvent(duplicate);
  assert.equal(first.outcome, "human_reply_reconciled");
  assert.equal(replay.outcome, "gmail_message_replay_suppressed");
  assert.equal((await adapters.close.getOpportunity(event.data.deal.opportunityId)).stage, "Replied");
  assert.ok(store.getSurface("deal", event.data.deal.opportunityId));
  assert.equal(slack.posts.filter((post) => !post.threadTs).length, 2);
  assert.equal(slack.posts.filter((post) => post.threadTs).length, 1);
  store.close();
});

test("failed event retries successfully without losing the human reply", async () => {
  const store = new CommandCenterStore(":memory:");
  const slack = new FailOnceSlackClient();
  const adapters = demoAdapters();
  const center = new CommandCenter(store, slack, adapters, config);
  const event = DEMO_EVENTS["human-reply"];
  assert(event?.type === "reply.received");
  await assert.rejects(() => center.handleEvent(structuredClone(event)), /Slack 500/);
  assert.equal(store.getEvent(event.id)?.status, "failed");
  const retry = await center.handleEvent(structuredClone(event));
  assert.equal(retry.outcome, "human_reply_reconciled");
  assert.equal(store.getEvent(event.id)?.attempts, 2);
  assert.equal((await adapters.close.getOpportunity(event.data.deal.opportunityId)).stage, "Replied");
  store.close();
});

test("repeated blocker updates one persistent card", async () => {
  const { store, slack, center } = harness();
  const event = DEMO_EVENTS.blocker;
  assert(event);
  await center.handleEvent(structuredClone(event));
  const repeat = structuredClone(event);
  repeat.id = "demo-blocker-002";
  const result = await center.handleEvent(repeat);
  assert.equal(result.outcome, "blocker_updated");
  assert.equal(store.blockerCount(), 1);
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.updates.length, 1);
  store.close();
});

test("live status queries Close, formats Phoenix time, and updates in place", async () => {
  const { store, slack, adapters, center } = harness();
  const event = DEMO_EVENTS.status;
  assert(event?.type === "run.status");
  await center.handleEvent(structuredClone(event));
  await adapters.close.transitionStage("demo-opp-claim", "Qualified", "Contacted");
  const next = structuredClone(event);
  next.id = "demo-status-002";
  await center.handleEvent(next);
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.updates.length, 1);
  const rendered = JSON.stringify(slack.updates[0]?.message);
  assert.match(rendered, /Counts: Close/);
  assert.match(rendered, /\d{2}:\d{2} MST/);
  assert.match(rendered, /Contacted[^0-9]*2/);
  store.close();
});

test("normal run START and END update status plus one daily thread without alert spam", async () => {
  const { store, slack, center } = harness();
  const started = DEMO_EVENTS["run-start"];
  const ended = DEMO_EVENTS["run-end"];
  assert(started?.type === "run.started" && ended?.type === "run.ended");
  assert.equal((await center.handleEvent(structuredClone(started))).outcome, "run_lifecycle_suppressed");
  assert.equal((await center.handleEvent(structuredClone(ended))).outcome, "run_lifecycle_suppressed");
  assert.equal(slack.posts.filter((post) => !post.threadTs).length, 2);
  assert.equal(slack.posts.filter((post) => post.threadTs).length, 2);
  assert.equal(slack.posts.some((post) => post.channelId === config.channels.alerts), false);
  store.close();
});

test("meeting, proposal, and payment request use deal parents plus timeline threads", async () => {
  const { store, slack, center } = harness();
  for (const name of ["meeting", "proposal", "payment-link"] as const) {
    const event = DEMO_EVENTS[name];
    assert(event);
    await center.handleEvent(structuredClone(event));
  }
  assert.equal(slack.posts.filter((post) => post.threadTs).length, 3);
  assert.ok(store.getSurface("deal", "demo-opp-meeting"));
  assert.ok(store.getSurface("deal", "demo-opp-proposal"));
  assert.ok(store.getSurface("deal", "demo-opp-payment-link"));
  store.close();
});

test("paid-job handoff dedupes by PaymentIntent across different event IDs", async () => {
  const store = new CommandCenterStore(":memory:");
  const slack = new MemorySlackClient();
  const close = new DemoCloseAdapter();
  const fulfillment = new DemoFulfillmentAdapter();
  const center = new CommandCenter(store, slack, { close, fulfillment, dedupe: new DemoDedupeAdapter() }, config);
  const event = DEMO_EVENTS.payment;
  assert(event?.type === "payment.succeeded");
  const result = await center.handleEvent(structuredClone(event));
  const duplicate = structuredClone(event);
  duplicate.id = "different-ingestion-same-payment-intent";
  const replay = await center.handleEvent(duplicate);
  assert.equal(result.outcome, "paid_job_ready");
  assert.equal(replay.outcome, "payment_intent_replay_suppressed");
  assert.equal((await close.getOpportunity(event.data.deal.opportunityId)).stage, "Won");
  assert.equal(fulfillment.jobs.size, 1);
  assert.equal(slack.posts.filter((post) => /PAID JOB READY/.test(post.message.text)).length, 1);
  store.close();
});

test("monday failure after verified Won is a retryable fulfillment failure, not payment doubt", async () => {
  const store = new CommandCenterStore(":memory:");
  const slack = new MemorySlackClient();
  const close = new DemoCloseAdapter();
  const fulfillment = new FailOnceFulfillmentAdapter();
  const center = new CommandCenter(store, slack, { close, fulfillment, dedupe: new DemoDedupeAdapter() }, config);
  const event = DEMO_EVENTS.payment;
  assert(event?.type === "payment.succeeded");
  const first = await center.handleEvent(structuredClone(event));
  assert.equal(first.outcome, "fulfillment_handoff_failed");
  assert.equal(first.retryable, true);
  assert.equal((await close.getOpportunity(event.data.deal.opportunityId)).stage, "Won");
  assert.match(slack.posts[0]?.message.text ?? "", /FULFILLMENT HANDOFF FAILED/);
  assert.equal(slack.posts.some((post) => /Payment needs review/.test(post.message.text)), false);
  const retry = await center.handleEvent(structuredClone(event));
  assert.equal(retry.outcome, "paid_job_ready");
  assert.equal(fulfillment.calls, 2);
  assert.match(slack.updates.find((update) => /recovered/.test(update.message.text))?.message.text ?? "", /recovered/);
  store.close();
});

test("ambiguous payment posts review and never writes Won", async () => {
  const store = new CommandCenterStore(":memory:");
  const slack = new MemorySlackClient();
  const close = new DemoCloseAdapter();
  const center = new CommandCenter(store, slack, { close, fulfillment: new DemoFulfillmentAdapter(), dedupe: new DemoDedupeAdapter() }, config);
  const event = DEMO_EVENTS["ambiguous-payment"];
  assert(event?.type === "payment.succeeded");
  const result = await center.handleEvent(structuredClone(event));
  assert.equal(result.outcome, "payment_review_required");
  assert.equal((await close.getOpportunity(event.data.deal.opportunityId)).stage, "Payment Link Sent");
  assert.match(slack.posts[0]?.message.text ?? "", /Payment needs review/);
  store.close();
});

test("all demo surfaces carry Actor and DEMO context and pass structural validation", async () => {
  const { store, slack, center } = harness();
  for (const [name, original] of Object.entries(DEMO_EVENTS)) {
    if (name === "ambiguous-payment") continue;
    const event = structuredClone(original);
    event.id = `render-${name}`;
    await center.handleEvent(event);
  }
  for (const item of [...slack.posts.map((x) => x.message), ...slack.updates.map((x) => x.message)]) {
    assert.doesNotThrow(() => validateSlackMessage(item));
    const raw = JSON.stringify(item.blocks);
    assert.match(raw, /Actor:/);
    assert.match(raw, /DEMO/);
  }
  store.close();
});

test("validator rejects Slack sections with empty text", () => {
  assert.throws(() => validateSlackMessage({ text: "bad", blocks: [{ type: "section", text: { type: "mrkdwn", text: "" }, fields: [{ type: "mrkdwn", text: "ok" }] }] }), /empty mrkdwn/);
});

test("demo blocker evidence must use a reserved .test host", async () => {
  const { store, center } = harness();
  const event = structuredClone(DEMO_EVENTS.blocker);
  assert(event?.type === "blocker.observed");
  event.data.evidence.url = "https://example.com/not-demo";
  await assert.rejects(() => center.handleEvent(event), /DEMO evidence/);
  store.close();
});

test("brief stays within the operator noise budget", async () => {
  const { store, slack, center } = harness();
  const event = DEMO_EVENTS.brief;
  assert(event?.type === "brief.requested");
  await center.handleEvent(structuredClone(event));
  assert.ok((slack.posts[0]?.message.blocks.length ?? 99) <= 12);
  store.close();
});

test("claim scenario rejects the second operator", async () => {
  const { store, center } = harness();
  const first = await center.claimProspect("demo-opp-claim", "Viktor", "2026-10-02T00:00:00Z");
  const collision = await center.claimProspect("demo-opp-claim", "ChatGPT", "2026-10-02T00:00:00Z");
  assert.deepEqual(first, { claimed: true, owner: "Viktor" });
  assert.deepEqual(collision, { claimed: false, owner: "Viktor" });
  store.close();
});

test("manual Slack action cannot set Won", async () => {
  const { store, center } = harness();
  await assert.rejects(() => center.advanceStage("demo-opp-001", "Won", "U-DEMO", true), /Stripe evidence/);
  store.close();
});
