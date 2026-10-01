import { loadConfig } from "../config.js";
import { CommandCenter } from "../service/command-center.js";
import { HttpSlackClient, StdoutSlackClient } from "../slack/client.js";
import { CommandCenterStore } from "../storage/store.js";
import { demoAdapters } from "./adapters.js";
import { DEMO_EVENTS } from "./fixtures.js";

const args = process.argv.slice(2);
const scenario = args.find((arg) => !arg.startsWith("--")) ?? "all";
const postToSlack = args.includes("--slack");
const config = loadConfig({ ...process.env, DEMO_MODE: "true", DATABASE_PATH: ":memory:" });
if (postToSlack) {
  if (!config.slackBotToken || !config.demoSlackChannelId) {
    throw new Error("--slack requires SLACK_BOT_TOKEN and DEMO_SLACK_CHANNEL_ID");
  }
  config.channels = {
    control: config.demoSlackChannelId,
    replies: config.demoSlackChannelId,
    pipeline: config.demoSlackChannelId,
    alerts: config.demoSlackChannelId,
    wins: config.demoSlackChannelId,
  };
}
const store = new CommandCenterStore(":memory:");
const slack = postToSlack ? new HttpSlackClient(config.slackBotToken ?? "") : new StdoutSlackClient();
const center = new CommandCenter(store, slack, demoAdapters(), config);

const available = ["claim", ...Object.keys(DEMO_EVENTS)];
const names = scenario === "all" ? available : [scenario];
for (const name of names) {
  if (name === "claim") {
    const first = await center.claimProspect("demo-opp-claim", "Viktor", "2026-10-02T23:15:00-07:00");
    const collision = await center.claimProspect("demo-opp-claim", "ChatGPT", "2026-10-02T23:15:00-07:00");
    process.stdout.write(`${JSON.stringify({ scenario: name, first, collision })}\n`);
    continue;
  }
  const event = DEMO_EVENTS[name];
  if (!event) {
    process.stderr.write(`Unknown demo scenario: ${name}\nAvailable: ${available.join(", ")}, all\n`);
    process.exitCode = 2;
    break;
  }
  const result = await center.handleEvent(structuredClone(event));
  process.stdout.write(`${JSON.stringify({ scenario: name, result })}\n`);
  if (name === "payment") {
    const duplicate = structuredClone(event);
    duplicate.id = `${event.id}-different-ingestion-id`;
    const replay = await center.handleEvent(duplicate);
    process.stdout.write(`${JSON.stringify({ scenario: "duplicate-payment-replay", result: replay })}\n`);
  }
  if (name === "human-reply") {
    const duplicate = structuredClone(event);
    duplicate.id = `${event.id}-different-ingestion-id`;
    const replay = await center.handleEvent(duplicate);
    process.stdout.write(`${JSON.stringify({ scenario: "duplicate-gmail-message", result: replay })}\n`);
  }
  if (name === "blocker") {
    const repeat = structuredClone(event);
    repeat.id = `${event.id}-repeat`;
    const repeated = await center.handleEvent(repeat);
    process.stdout.write(`${JSON.stringify({ scenario: "repeated-blocker", result: repeated })}\n`);
  }
}

if (slack instanceof StdoutSlackClient) {
  process.stdout.write(`${JSON.stringify({ summary: { posts: slack.posts.length, updates: slack.updates.length, events: store.eventCount(), blockers: store.blockerCount(), audits: store.auditCount() } })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ summary: { transport: "slack-demo-channel", events: store.eventCount(), blockers: store.blockerCount(), audits: store.auditCount() } })}\n`);
}
store.close();
