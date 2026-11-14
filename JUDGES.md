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

**What this command is:** a local simulation of market, verification, escrow, and settlement. It does not submit testnet transactions and does not run an on-chain auction.

---

## Live testnet verification

The deployment transaction is real and final. The lifecycle is not.

| Item | Value |
|------|-------|
| Contract | `caliper.testnet` |
| Transaction | `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z` |
| Status | `FINAL` |
| Actions | `DeployContract` + `FunctionCall` (`init`) |
| Explorer | https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z |
| Deployed code hash | `Hst7gb5bXE4DoY99CgbrG2McRGBm41LkUKodpF7Fc2Bh` |

Do this, see that:

```bash
near view caliper.testnet get_owner
# "caliper.testnet"

near view caliper.testnet get_root
# null

near view caliper.testnet get_total_allocated
# "0"

near view caliper.testnet list_jobs
# []
```

This proves the account exists, bytecode is deployed, and `init` executed. It does **not** prove any job, verification, or payment ran on testnet. The deployed bytecode also predates the corrected settlement logic in this working tree; redeploy before claiming on-chain lifecycle behavior.

---

## Complete judge checklist

| Step | Command | Expected result |
|------|---------|-----------------|
| 1. Install dependencies | `npm install` | No errors |
| 2. Run adversarial demo | `npm run demo` | Attempt 1 rejected, attempt 2 verified, payment Paid |
| 3. Run contract tests | `cd contract && cargo test` | Contract suite passes |
| 4. Run off-chain tests | `npm run test:node` | Node suite passes |
| 5. Verify exported-state fixtures | `npm run verify` | Both sample fixtures pass |
| 6. Build wasm artifact | `cd contract && cargo build --release --target wasm32-unknown-unknown` | Wasm produced |
| 7. Verify testnet deployment | `near view caliper.testnet get_owner` | `"caliper.testnet"` |
| 8. Confirm lifecycle is unexecuted | `near view caliper.testnet list_jobs` | `[]` |

Step 8 is not a failure. It is the honest boundary of the evidence.

---

## What to check

| Claim | Evidence |
|-------|----------|
| Tampering detected | `demo/runs/latest/attempt-1-report.json` shows `protected_violations` non-empty |
| Correction passes original suite | `demo/runs/latest/attempt-2-report.json` shows `passed: true` |
| Policy hash recomputed before signing | `demo/runner.ts` aborts on hash mismatch |
| Market transcript hash matches job | `integrity.market_transcript_hash_matches_job` is `true` in run.json |
| Market is off-chain | `integrity.market_selection_validated_by_contract` is `false` |
| Payment waits for callback | `payment.status = PaymentPending`, then `payment.state = Paid` |
| Same worker gets correction | `selected_worker_unchanged_after_failure` is `true` |
| Exact bid is paid | `integrity.settlement_amount_equals_winning_bid` is `true`; `payment.budget === market.winner_bid.amount` |
| Coordinator cannot withhold | `integrity.payment_permissionless_after_verification` is `true` |
| Coordinator cannot cancel verified work | `integrity.coordinator_cannot_cancel_verified_job` is `true` |

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
9. Verification passes. Payment becomes a fixed obligation.
10. The worker (or anyone) releases it. Local chain settles via callback for exactly the winning bid.

---

## What is real vs simulated

**Real code:** NEAR contract, canonical attestation, Ed25519 signing, diff computation, policy-hash recomputation, protected-file checks, pinned test execution, payment state machine, permissionless settlement, revocation guards.

**Simulated:** the bid market and winner selection (deterministic, off-chain), local chain mirror identities, and the displayed receipts. No on-chain transaction is invented. The UI labels the simulation.

**Verified on testnet:** deployment and `init` only. `get_root` is `null`, `get_total_allocated` is `"0"`, and `list_jobs` is `[]`. No lifecycle has run there.

**Deployment caveat:** the testnet bytecode predates the corrected settlement code in this working tree.

**Runner isolation:** default execution is process-only (scrubbed env, fixed cwd, timeout). It is not a security boundary. `CALIPER_SANDBOX=os` selects a fail-closed OS sandbox on macOS or Linux.
