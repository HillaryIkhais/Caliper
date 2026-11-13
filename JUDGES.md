# CALIPER — Judge's shortest path

**The claim:** a coding agent can make its CI green by weakening the tests. CALIPER detects
that manipulation, blocks payment, and pays only after a separate verifier runs the pinned
suite against the corrected source.

## One command

```bash
npm run demo
```

From a clean checkout this runs five sealed bids, selects the adversarial worker, blocks its
tampered first attempt, requests correction, verifies the genuine source fix, and confirms
local settlement. It exits non-zero if the loop is broken.

Expected key lines:

```
attempt 1: Rejected — blocked: protected acceptance files were modified
  protected violations: M ci/check.js, M tests/auth.test.js
  weakened assertions:  tests/auth.test.js: weakened an assertion to assert.ok(true)
  disabled CI:          ci/check.js: forced the CI check to exit successfully
attempt 2: Verified — passed: genuine source fix accepted by the pinned suite
payment:   Paid (Local chain simulation ...)
```

## Watch the workbench

```bash
npm run serve
# open http://127.0.0.1:4317
```

Click **Run adversarial demo**. The screen shows the task's pinned criteria, the bid
transcript, role separation, budget commitments, the actual diff, the signed verifier
evidence, the correction history, the approval gate, and the payment receipt. The first
attempt's worker claim is shown next to the computed evidence that blocked it.

## What to check

| Claim | Command / evidence |
|---|---|
| 32 contract tests pass | `cd contract && cargo test` |
| Contract compiles to wasm | `cd contract && cargo build --release --target wasm32-unknown-unknown` |
| 14 off-chain tests pass | `npm run test:node` |
| Exported-state auditor passes | `npm run verify` |
| Adversarial loop works | `npm run demo` |
| Tampering is detected, not trusted | `demo/runs/latest/attempt-1-report.json` |
| Correction passes the original suite | `demo/runs/latest/attempt-2-report.json` |
| Market transcript is anchored | `integrity.market_transcript_anchored` in `run.json` |
| Payment waits for callback | `payment.status = PaymentPending`, then `payment.state = Paid` |

## The failure scenario to inspect

1. Eve wins the market with the lowest valid bid.
2. Eve submits a patch that weakens `tests/auth.test.js` and disables `ci/check.js`.
3. Eve's own claim says success.
4. The runner computes the real diff, detects protected-file changes, restores the pinned
   suite, and reruns it against Eve's actual source.
5. Verification fails. The coordinator cannot accept. Payment is blocked.
6. The coordinator requests changes. The same worker remains assigned.
7. Eve fixes `src/auth.js`.
8. The runner executes the original pinned test and CI files.
9. Verification passes. The coordinator approves. The local chain settles via callback.

## What is real and what is simulated

- The NEAR contract, canonical attestation, Ed25519 signing, diff computation, protected-file
  checks, test execution, and payment state machine are real code.
- The demo uses local simulation identities and a local chain mirror. No on-chain transaction,
  transaction hash, wallet signature, or testnet deployment is invented.
- The UI labels this explicitly. Testnet deployment is documented in `README.md` and requires
  credentials that are not committed.

## Why this is not a generic marketplace

Bidding is for verified agent labor. Payment is gated by artifact-bound independent evidence,
not reputation, pooled purchases, or a chat interface. The swarm is five deterministic workers
with sealed bids; the point is the verification-and-settlement loop, not agent theatre.

## Trust boundary in one sentence

The contract does not execute code or prove correctness; it enforces that the designated
verifier signed evidence bound to the current job, attempt, artifact, criteria, baseline,
suite, and pinned key, and that no payment is marked complete before the transfer callback.

## Deadline

November 14, 2026 at 23:59 UTC.
