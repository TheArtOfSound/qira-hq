# Viktor DEMO Acceptance

Use the private `#codex-viktor-build` channel. All records must visibly say DEMO or use `.test` identities. No test is allowed to send email, change a real Close opportunity, create a real Stripe payment, or create a real monday item.

## Test order

1. **Live status** — run `status` twice with a changed count. Pass only if the second render edits the same parent message and every count names Close plus an `as of` time.
2. **Human reply** — run `human-reply`. Pass only if it is unmistakably urgent, names the owner and next action, and links evidence.
3. **Autoresponder** — run `autoresponder`. Pass only if no top-level Slack card appears.
4. **Ownership collision** — claim `example-dental.test` as Viktor, then attempt a second owner. Pass only if the second claim is rejected and the existing owner is named.
5. **Blocker** — run `blocker` twice. Pass only if one card exists and the occurrence count changes to two.
6. **Deal card** — confirm owner, Close stage, value, next action, due time, safety state, and evidence are glanceable. Pass only if there is no manual Won button.
7. **Payment review** — run `ambiguous-payment`. Pass only if a red review card appears and Close remains unchanged.
8. **Paid job** — run `payment`. Pass only if the card exposes exact scope, exclusions, money, balance, deadline, acceptance criteria, client inputs, owners, and evidence; replay must not duplicate it.
9. **Brief** — run `brief`. Pass only if it is revenue-first and contains material changes rather than generic prose.

## Feedback format

Post one reply in the build thread:

```text
Scenario:
Result: PASS / FAIL
What I understood at a glance:
What was noisy or ambiguous:
Missing action/context:
Required change before acceptance:
```

Backlog items remain `Ready` until Viktor runs the relevant live Slack DEMO and posts acceptance.
