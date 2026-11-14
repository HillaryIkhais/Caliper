# CALIPER — Judge's shortest path

**Built for NEAR HACKATHON 2026 — Track 05: AI Swarms**

**The claim:** a coding agent can make its CI green by weakening the tests. CALIPER detects that manipulation, blocks payment, and pays only after a separate verifier runs the pinned suite against the corrected source.

---

## One command (local simulation — no wallet, no network)

```bash
npm run demo
```

From a clean checkout this runs five deterministic commit/reveal bids, selects the adversarial worker, blocks its tampered first attempt, requests correction, verifies the genuine source fix, and confirms local settlement. It exits non-zero if the loop is broken.

Expected key lines:

```
attempt 1: Rejected — blocked: protected acceptance files were modified
  protected violations: M ci/check.js, M tests/auth.test.js
  weakened assertions:  tests/auth.test.js: weakened an assertion to assert.ok(true)
  disabled CI:          ci/check.js: forced the CI check to exit successfully
attempt 2: Verified — passed: genuine source fix accepted by the pinned suite
payment:   Paid (Local chain simulation ...)
```

---

## Live testnet verification

The contract is deployed on NEAR testnet:

| Item | Value |
|------|-------|
| Contract | `caliper.testnet` |
| Transaction | `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z` |
| Explorer | https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z |
| WASM SHA-256 | `fac3d3d2c2a4ca206085b96e6ddb9223a4bb8b4d8882ef19cd5dba717593c0a8` |

Do this, see that:
- `near view caliper.testnet get_total_allocated` → returns a positive number (contract is deployed and funded)
- `near state caliper.testnet` → shows account exists on testnet

---

## Complete judge checklist

| Step | Command | Expected result |
|------|---------|-----------------|
| 1. Install dependencies | `npm install` | No errors |
| 2. Run adversarial demo | `npm run demo` | Attempt 1 rejected, attempt 2 verified, payment Paid |
| 3. Run contract tests | `cd contract && cargo test` | 39 tests pass |
| 4. Run off-chain tests | `npm run test:node` | 20 tests pass |
| 5. Verify exported-state fixtures | `npm run verify` | Both sample fixtures pass |
| 6. Build wasm artifact | `cd contract && cargo build --release --target wasm32-unknown-unknown` | ~331 KB wasm produced |
| 7. Verify testnet contract | `near view caliper.testnet get_total_allocated` | Positive number returned |

---

## What to check

| Claim | Evidence |
|-------|----------|
| Tampering detected | `demo/runs/latest/attempt-1-report.json` shows `protected_violations` non-empty |
| Correction passes original suite | `demo/runs/latest/attempt-2-report.json` shows `passed: true` |
| Policy hash recomputed before signing | `demo/runner.ts` aborts on hash mismatch |
| Market transcript hash matches job | `integrity.market_transcript_hash_matches_job` is `true` in run.json |
| Payment waits for callback | `payment.status = PaymentPending`, then `payment.state = Paid` |
| Same worker gets correction | `selected_worker_unchanged_after_failure` is `true` |

---

## The failure scenario to inspect

1. Eve wins the market with the lowest valid bid.
2. Eve submits a patch that weakens `tests/auth.test.js` and disables `ci/check.js`.
3. Eve's own claim says success.
4. The runner computes the real diff, detects protected-file changes, restores the pinned suite, reruns it against Eve's actual source.
5. Verification fails. Payment blocked.
6. Coordinator requests changes. Same worker remains assigned.
7. Eve fixes `src/auth.js`.
8. Runner executes the original pinned test and CI files.
9. Verification passes. Coordinator approves. Local chain settles via callback.

---

## What is real vs simulated

**Real code:** NEAR contract, canonical attestation, Ed25519 signing, diff computation, policy-hash recomputation, protected-file checks, test execution, payment state machine.

**Simulated:** Bid nonces (deterministic for reproducibility), local chain mirror identities, no on-chain transaction invented. The UI explicitly labels this.

The live testnet contract at `caliper.testnet` confirms identical state transitions with actual NEAR settlement.
