import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { demoAdapters } from "./demo/adapters.js";
import { DEMO_EVENTS } from "./demo/fixtures.js";
import { loadConfig } from "./config.js";
import type { RevenueEvent, SalesStage } from "./domain/types.js";
import { unconfiguredAdapters } from "./adapters/interfaces.js";
import { bearerAuthorized, verifySlackRequest } from "./http/security.js";
import { CommandCenter } from "./service/command-center.js";
import { HttpSlackClient, StdoutSlackClient } from "./slack/client.js";
import { CommandCenterStore } from "./storage/store.js";

const config = loadConfig();
if (!config.demoMode && (!config.slackBotToken || !config.slackSigningSecret || !config.ingestToken)) {
  throw new Error("Production mode requires SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, and QIRA_INGEST_TOKEN");
}

const store = new CommandCenterStore(config.databasePath);
const slack = config.slackBotToken ? new HttpSlackClient(config.slackBotToken) : new StdoutSlackClient();
const adapters = config.demoMode ? demoAdapters() : unconfiguredAdapters();
const center = new CommandCenter(store, slack, adapters, config);

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseEvent(raw: string): RevenueEvent {
  const value = JSON.parse(raw) as Partial<RevenueEvent>;
  if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.occurredAt !== "string" || typeof value.source !== "string" || typeof value.actor !== "string" || typeof value.demo !== "boolean" || !("data" in value)) {
    throw new Error("Invalid revenue event envelope");
  }
  const allowed = new Set(["reply.received", "meeting.booked", "deal.updated", "proposal.sent", "payment.requested", "payment.succeeded", "blocker.observed", "run.status", "run.started", "run.ended", "brief.requested"]);
  if (!allowed.has(value.type)) throw new Error("Unsupported revenue event type");
  if (config.demoMode && value.demo !== true) throw new Error("DEMO_MODE accepts synthetic demo events only");
  return value as RevenueEvent;
}

async function handleSlackAction(raw: string): Promise<string> {
  const payloadRaw = new URLSearchParams(raw).get("payload");
  if (!payloadRaw) throw new Error("Missing Slack interaction payload");
  const payload = JSON.parse(payloadRaw) as {
    user?: { id?: string; username?: string; name?: string };
    actions?: Array<{ action_id?: string; value?: string }>;
  };
  const actorId = payload.user?.id;
  const actor = payload.user?.username ?? payload.user?.name ?? actorId;
  const action = payload.actions?.[0];
  if (!actorId || !actor || !action?.action_id || !action.value) throw new Error("Malformed Slack interaction payload");
  const value = JSON.parse(action.value) as { opportunityId?: string; rootDomain?: string; to?: SalesStage };
  if (action.action_id === "claim_prospect" && value.opportunityId) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await center.claimProspect(value.opportunityId, actor, expiresAt);
    return result.claimed ? `Claimed for ${actor}. Gmail and Close dedupe evidence recorded.` : `Claim rejected. Current owner: ${result.owner}.`;
  }
  if (action.action_id === "release_prospect" && value.rootDomain) {
    return center.releaseProspect(value.rootDomain, actor) ? "Prospect released." : "Release rejected. Only the current owner can release this prospect.";
  }
  if (action.action_id === "advance_stage" && value.opportunityId && value.to) {
    const result = await center.advanceStage(value.opportunityId, value.to, actor, config.demoMode);
    return `Close confirmed ${result.company} → ${result.stage}. Slack card refreshed.`;
  }
  if (action.action_id === "mark_lost" && value.opportunityId) {
    const result = await center.advanceStage(value.opportunityId, "Lost", actor, config.demoMode);
    return `Close confirmed ${result.company} → Lost. Slack card refreshed.`;
  }
  if (action.action_id === "raise_blocker") return "Use the blocker intake endpoint with exact failure evidence; no incomplete blocker was created.";
  throw new Error("Unsupported Slack action");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, mode: config.demoMode ? "demo" : "production", database: "available", adapters: config.demoMode ? "synthetic" : "fail-closed pending configuration" });
    }
    if (req.method === "GET" && url.pathname === "/demo/scenarios") {
      return json(res, 200, { enabled: config.demoMode, scenarios: config.demoMode ? ["claim", ...Object.keys(DEMO_EVENTS)] : [] });
    }
    if (req.method === "POST" && url.pathname.startsWith("/demo/")) {
      if (!config.demoMode) return json(res, 404, { error: "Demo mode disabled" });
      const name = decodeURIComponent(url.pathname.slice("/demo/".length));
      if (name === "claim") {
        const first = await center.claimProspect("demo-opp-claim", "Viktor", new Date(Date.now() + 86_400_000).toISOString());
        const collision = await center.claimProspect("demo-opp-claim", "ChatGPT", new Date(Date.now() + 86_400_000).toISOString());
        return json(res, 200, { first, collision });
      }
      const event = DEMO_EVENTS[name];
      if (!event) return json(res, 404, { error: "Unknown demo scenario", scenarios: ["claim", ...Object.keys(DEMO_EVENTS)] });
      return json(res, 200, await center.handleEvent(structuredClone(event)));
    }
    if (req.method === "POST" && url.pathname === "/events") {
      if (!bearerAuthorized(req.headers.authorization, config.ingestToken)) return json(res, 401, { error: "Unauthorized" });
      const event = parseEvent(await readBody(req));
      return json(res, 200, await center.handleEvent(event));
    }
    if (req.method === "POST" && (url.pathname === "/slack/events" || url.pathname === "/slack/actions")) {
      const raw = await readBody(req);
      if (!config.slackSigningSecret || !verifySlackRequest({ signingSecret: config.slackSigningSecret, timestamp: req.headers["x-slack-request-timestamp"] as string | undefined, signature: req.headers["x-slack-signature"] as string | undefined, rawBody: raw })) {
        return json(res, 401, { error: "Invalid Slack signature" });
      }
      if (url.pathname === "/slack/events") {
        const body = JSON.parse(raw) as { type?: string; challenge?: string };
        if (body.type === "url_verification" && body.challenge) return json(res, 200, { challenge: body.challenge });
        return json(res, 202, { accepted: true });
      }
      const text = await handleSlackAction(raw);
      return json(res, 200, { response_type: "ephemeral", replace_original: false, text });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return json(res, 400, { error: message });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`Qira command center listening on http://127.0.0.1:${config.port} (${config.demoMode ? "DEMO" : "production"})\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
