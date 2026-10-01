import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { demoAdapters, DemoCloseAdapter, DemoDedupeAdapter, DemoFulfillmentAdapter } from "../src/demo/adapters.js";
import { DEMO_EVENTS } from "../src/demo/fixtures.js";
import { CommandCenter } from "../src/service/command-center.js";
import { MemorySlackClient } from "../src/slack/client.js";
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

test("autoresponder suppression creates no hot-inbox post", async () => {
  const { store, slack, center } = harness();
  const event = DEMO_EVENTS.autoresponder;
  assert(event);
  const result = await center.handleEvent(structuredClone(event));
  assert.equal(result.outcome, "autoresponder_suppressed");
  assert.equal(slack.posts.length, 0);
  store.close();
});

test("human reply escalates once and replay is idempotent", async () => {
  const { store, slack, center } = harness();
  const event = DEMO_EVENTS["human-reply"];
  assert(event);
  const first = await center.handleEvent(structuredClone(event));
  const replay = await center.handleEvent(structuredClone(event));
  assert.equal(first.outcome, "human_reply_posted");
  assert.equal(replay.duplicate, true);
  assert.equal(slack.posts.length, 1);
  store.close();
});

test("repeated blocker updates aggregate and does not repost", async () => {
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

test("live status uses one persistent message and updates in place", async () => {
  const { store, slack, center } = harness();
  const event = DEMO_EVENTS.status;
  assert(event);
  await center.handleEvent(structuredClone(event));
  const next = structuredClone(event);
  next.id = "demo-status-002";
  next.data.counts.contacted += 1;
  await center.handleEvent(next);
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.updates.length, 1);
  store.close();
});

test("paid-job handoff requires payment, writes Close, creates fulfillment, and dedupes replay", async () => {
  const store = new CommandCenterStore(":memory:");
  const slack = new MemorySlackClient();
  const close = new DemoCloseAdapter();
  const fulfillment = new DemoFulfillmentAdapter();
  const center = new CommandCenter(store, slack, { close, fulfillment, dedupe: new DemoDedupeAdapter() }, config);
  const event = DEMO_EVENTS.payment;
  assert(event?.type === "payment.succeeded");
  const result = await center.handleEvent(structuredClone(event));
  const replay = await center.handleEvent(structuredClone(event));
  assert.equal(result.outcome, "paid_job_ready");
  assert.equal((await close.getOpportunity(event.data.deal.opportunityId)).stage, "Won");
  assert.equal(fulfillment.jobs.size, 1);
  assert.equal(slack.posts.length, 1);
  assert.equal(replay.duplicate, true);
  assert.match(slack.posts[0]?.message.text ?? "", /PAID JOB READY/);
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

test("Slack render payloads validate for all posting demo scenarios", async () => {
  const { store, slack, center } = harness();
  for (const [name, original] of Object.entries(DEMO_EVENTS)) {
    if (name === "ambiguous-payment") continue;
    const event = structuredClone(original);
    event.id = `render-${name}`;
    await center.handleEvent(event);
  }
  for (const post of slack.posts) assert.doesNotThrow(() => validateSlackMessage(post.message));
  for (const update of slack.updates) assert.doesNotThrow(() => validateSlackMessage(update.message));
  assert.ok(slack.posts.length >= 7);
  store.close();
});

test("manual Slack action cannot set Won", async () => {
  const { store, center } = harness();
  await assert.rejects(() => center.advanceStage("demo-opp-001", "Won", "U-DEMO"), /Stripe evidence/);
  store.close();
});
