import assert from "node:assert/strict";
import test from "node:test";
import { assertAttributablePayment, assertStageTransition, canTransitionStage } from "../src/domain/safety.js";
import { DEMO_DEAL, DEMO_PAYMENT } from "../src/demo/fixtures.js";

test("Close stage transitions allow only the next stage or Lost", () => {
  assert.equal(canTransitionStage("Qualified", "Contacted"), true);
  assert.equal(canTransitionStage("Qualified", "Proposal Sent"), false);
  assert.equal(canTransitionStage("Replied", "Lost"), true);
  assert.throws(() => assertStageTransition("Qualified", "Proposal Sent"));
});

test("Won requires exactly attributed succeeded Stripe evidence", () => {
  assert.doesNotThrow(() => assertStageTransition("Payment Link Sent", "Won", DEMO_PAYMENT));
  assert.throws(() => assertStageTransition("Payment Link Sent", "Won"), /Stripe payment/);
  assert.throws(() => assertStageTransition("Payment Link Sent", "Won", { ...DEMO_PAYMENT, status: "processing" }), /Stripe payment/);
});

test("ambiguous or wrong-account payments fail closed", () => {
  assert.throws(() => assertAttributablePayment({ ...DEMO_PAYMENT, attribution: "ambiguous" }, DEMO_DEAL, DEMO_PAYMENT.stripeAccountId), /ambiguous/);
  assert.throws(() => assertAttributablePayment({ ...DEMO_PAYMENT, stripeAccountId: "acct_wrong" }, DEMO_DEAL, DEMO_PAYMENT.stripeAccountId), /unapproved/);
  assert.throws(() => assertAttributablePayment({ ...DEMO_PAYMENT, paymentKind: "unknown" }, DEMO_DEAL, DEMO_PAYMENT.stripeAccountId), /Deposit/);
});
