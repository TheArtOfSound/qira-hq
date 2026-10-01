import assert from "node:assert/strict";
import test from "node:test";
import { CommandCenterStore } from "../src/storage/store.js";

const dedupe = {
  rootDomain: "example.test",
  checkedAt: "2026-10-01T00:00:00Z",
  gmailQueryId: "gmail-q-1",
  closeQueryId: "close-q-1",
  gmailClear: true,
  closeClear: true,
};

test("ownership collision preserves one owner", () => {
  const store = new CommandCenterStore(":memory:");
  const first = store.claimProspect({ company: "Example", rootDomain: "www.example.test", owner: "Viktor", expiresAt: "2026-10-02T00:00:00Z", dedupe, now: "2026-10-01T00:00:00Z" });
  const second = store.claimProspect({ company: "Example", rootDomain: "example.test", owner: "ChatGPT", expiresAt: "2026-10-02T00:00:00Z", dedupe, now: "2026-10-01T00:01:00Z" });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.record.owner, "Viktor");
  assert.equal(store.getOwnership("example.test")?.owner, "Viktor");
  store.close();
});

test("claim requires Gmail and Close dedupe evidence", () => {
  const store = new CommandCenterStore(":memory:");
  assert.throws(() => store.claimProspect({ company: "Example", rootDomain: "example.test", owner: "Viktor", expiresAt: "2026-10-02T00:00:00Z", dedupe: { ...dedupe, gmailClear: false } }));
  store.close();
});

test("blocker repeats aggregate without duplicate records", () => {
  const store = new CommandCenterStore(":memory:");
  const blocker = { key: "gmail:send:footer", system: "Gmail", action: "send", exactFailure: "footer missing", businessImpact: "first touches blocked", revenueImpact: "pipeline paused", owner: "Bryan", smallestFix: "approve footer", status: "Open" as const, evidence: { label: "Run", url: "https://airtable.example.test/run/1", source: "airtable" as const } };
  assert.equal(store.upsertBlocker(blocker, "2026-10-01T00:00:00Z").isNew, true);
  const repeat = store.upsertBlocker(blocker, "2026-10-01T01:00:00Z");
  assert.equal(repeat.isNew, false);
  assert.equal(repeat.record.occurrenceCount, 2);
  assert.equal(store.blockerCount(), 1);
  store.close();
});

test("failed events retry, stale processing is reclaimed, and active processing is suppressed", () => {
  const store = new CommandCenterStore(":memory:");
  assert.equal(store.beginEvent("failed", "reply.received", "2026-10-01T00:00:00Z", 60), true);
  store.finishEvent("failed", "failed", { error: "transient" }, "2026-10-01T00:00:10Z");
  assert.equal(store.beginEvent("failed", "reply.received", "2026-10-01T00:00:20Z", 60), true);

  assert.equal(store.beginEvent("stale", "reply.received", "2026-10-01T00:00:00Z", 60), true);
  assert.equal(store.beginEvent("stale", "reply.received", "2026-10-01T00:02:00Z", 60), true);
  assert.equal(store.getEvent("stale")?.attempts, 2);

  assert.equal(store.beginEvent("active", "reply.received", "2026-10-01T00:00:00Z", 60), true);
  assert.equal(store.beginEvent("active", "reply.received", "2026-10-01T00:00:30Z", 60), false);
  assert.equal(store.getEvent("active")?.attempts, 1);
  store.close();
});
