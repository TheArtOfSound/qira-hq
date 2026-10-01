import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { bearerAuthorized, verifySlackRequest } from "../src/http/security.js";

test("Slack signature verification accepts fresh valid signatures and rejects replay", () => {
  const secret = "demo-signing-secret";
  const timestamp = "1790834407";
  const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  assert.equal(verifySlackRequest({ signingSecret: secret, timestamp, signature, rawBody, nowSeconds: Number(timestamp) + 30 }), true);
  assert.equal(verifySlackRequest({ signingSecret: secret, timestamp, signature, rawBody, nowSeconds: Number(timestamp) + 301 }), false);
});

test("bearer comparison fails closed", () => {
  assert.equal(bearerAuthorized("Bearer demo-token", "demo-token"), true);
  assert.equal(bearerAuthorized("Bearer wrong", "demo-token"), false);
  assert.equal(bearerAuthorized(undefined, "demo-token"), false);
});
