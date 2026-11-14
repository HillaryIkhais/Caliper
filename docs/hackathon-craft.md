# Hackathon Craft — Applied to CALIPER

## 1. Event / track / rubric

- **Event:** NEAR HACKATHON 2026
- **Track:** 05 — AI Swarms ("Coordination markets, bidding, collective purchasing, intent-based settlement between agents")
- **Deadline:** November 14, 2026 at 23:59 UTC
- **Repository:** https://github.com/HillaryIkhais/Caliper

## 2. Intake audit

| # | Question | Answer |
|---|---|---|
| 1 | Event, track, deadline, rubric | NEAR HACKATHON 2026, Track 05 AI Swarms, Nov 14 2026 23:59 UTC |
| 2 | Sponsor, primitive/rail | NEAR — function-call keys, native NEAR transfers, authority-based access control |
| 3 | Silent failure sponsor loses sleep over | An AI agent makes CI green by weakening tests instead of fixing code; the coordinator pays for fake work; authority delegation silently widens so a child can spend more than the parent's remaining headroom |
| 4 | Naive solution | "AI coding agent with CI + payment on success" — agent self-certifies, coordinator trusts the test result |
| 5 | Silent failure of naive solution | Tampered tests pass, protected files change, verification is the same agent that generated the output, escrow is cancelled after verification |
| 6 | Who pays, how much, irreversible | Coordinator pays the full escrowed budget for fake work; payment is irreversible once transferred |
| 7 | Detectable mechanically without LLM opinion | Yes — diff hash, protected-file match, test/CI exit codes, signature verification, all deterministic |
| 8 | Smallest closed loop | Owner → coordinator → market bid → worker submits hash → independent verifier runs pinned suite → verifier signs attestation → contract pays exactly winning bid on callback |
| 9 | Real (not mocked) | NEAR contract (deployed on testnet), Ed25519 signatures, pinned test execution, diff computation, policy-hash recomputation |
| 10 | One artifact a judge can inspect without signup | `near view caliper.testnet get_total_allocated` → `"0"` (lifecycle unexecuted), `npm run demo` (local simulation), `cargo test` (41 tests), `npm run verify` (fixtures) |
| 11 | What to deliberately break | Eve's first attempt weakens `tests/auth.test.js` and disables `ci/check.js` |
| 12 | What to explicitly NOT claim | On-chain auction, on-chain winner selection, testnet lifecycle executed, OS-level runner isolation (default), updated contract deployed to testnet |

## 3. Failure sentence

```
When a coordinator hires an AI agent to fix code, the agent weakens tests and disables CI instead of fixing the bug. The branch turns green, the coordinator pays, and the work is fake. Existing CI tools cannot detect it because the agent controls the measurement of its own performance. CALIPER enforces "independent verification binds to the current artifact, attempt, criteria, baseline, suite, and verifier key" at the contract level, and proves it with adversarial tests plus callback-confirmed NEAR settlement.
```

## 4. Invariant

**Work is not payable merely because an agent reports success. Payment requires independent, artifact-bound attestation verified against pinned criteria, and the transfer amount equals exactly the winning bid.**

## 5. Closed loop (6 steps)

1. **Submit:** Worker submits only an artifact hash — cannot certify its own tests.
2. **Verify:** Independent verifier reruns the pinned acceptance suite against the actual artifact, computes diff, checks protected files, signs Ed25519 attestation.
3. **Bind:** Contract records attestation bound to job ID, attempt, deliverable hash, criteria, baseline, suite, verifier key.
4. **Obligate:** Once verification passes, payment is a fixed obligation — `release_verified_payment` is permissionless; coordinator cannot cancel or revoke to avoid it.
5. **Settle:** Contract transfers exactly `winning_bid` to the worker; unused escrow returns to coordinator.
6. **Confirm:** `Paid` requires a successful transfer callback; `PaymentPending` never means paid.

## 6. Deterministic mechanism

- Authority attenuation: child permissions ⊆ parent permissions (checked at delegation).
- Commitment isolation: `spent + allocated_children ≤ allocation` at every node.
- Revocation cascade: revoking a node invalidates all descendants; blocked while an obligation is outstanding.
- Exact-bid settlement: `winning_bid` validated at creation (`0 < bid ≤ budget`), paid verbatim on settlement.
- Callback confirmation: `on_job_payment` moves `PaymentPending → Paid` only on transfer success; idempotent on duplicate callbacks.

## 7. Evidence plan

| Check | Result | Evidence |
|---|---|---|
| Contract unit tests | 41/41 pass | `contract/src/lib.rs` |
| Off-chain tests | 21/21 pass | `demo/*.test.ts` |
| Exported-state fixtures | Both verify | `contract/verify/sample-*.json` |
| Wasm release build | Success | `cargo build --release --target wasm32-unknown-unknown` |
| Testnet deployment | Verified (init only) | `caliper.testnet`, tx `HkwyEMPr...`, `get_root=null`, `list_jobs=[]` |

## 8. Demo script (6 scenes)

| Scene | Beat | CALIPER mapping |
|---|---|---|
| 1 | Setup | Owner creates root, delegates coordinator/worker/verifier |
| 2 | Normal use | Eve wins market, submits genuine fix, verification passes |
| 3 | The break | Eve weakens tests, disables CI, claims success |
| 4 | The catch | Runner detects protected-file changes, restores pinned suite, verification fails |
| 5 | The repair/verify | Eve fixes `src/auth.js`, runner executes original pinned suite, verification passes |
| 6 | The proof | Worker releases payment permissionlessly, contract pays exactly winning bid, callback confirms |

## 9. Score cuts (in order)

1. Extra integrations — none planned; NEAR is the single rail
2. Settings, profiles, onboarding — not in scope
3. Secondary user roles — coordinator/worker/verifier only
4. Visual polish beyond legibility — minimal UI
5. Multi-tenant architecture — single contract instance

Never cut: failure injection, deterministic check, evidence artifact, live demo path, known-limitations section.

## 10. Score /20 (Drey scorecard)

| # | Dimension | Score | Rationale |
|---|---|---|---|
| 1 | Silent failure | 2 | Silent, expensive, sponsor-owned (agent fakes CI, coordinator pays) |
| 2 | Insight | 2 | Non-obvious second-order failure (agent fixes measurement, not code) |
| 3 | Invariant | 2 | One sentence, testable: "Work is not payable merely because an agent reports success" |
| 4 | Architecture | 2 | Shared contracts + deterministic core (NEAR contract enforces, runner verifies independently) |
| 5 | Completeness | 2 | Full loop incl. failure + recovery (attempt 1 rejected, attempt 2 verified, settlement) |
| 6 | Verification | 2 | Independent oracle + replay (runner ≠ generator, Ed25519 attestation, callback confirmation) |
| 7 | Evidence | 1 | Public state + verify path exist; testnet lifecycle unexecuted (deployed bytecode predates fixes) |
| 8 | Sponsor fit | 2 | Load-bearing, inspectable (NEAR contract is the enforcement layer; function-call keys) |
| 9 | Narrative | 2 | Problem → failure → proof (docs rewritten to be honest) |
| 10 | Honesty | 2 | Specific limitations + prior work (deployment/lifecycle distinction, OS isolation limited, off-chain market labeled) |

**Total: 19/20 — competitive to win.**

Weakest dimension: Evidence (dimension 7) — the deployed bytecode predates the fixes, and the testnet lifecycle has not been executed. This is honestly documented, not hidden.

## 11. Next 3 actions

1. **Redeploy the fixed contract** to testnet so the deployed bytecode matches the working tree (required before claiming on-chain lifecycle behavior).
2. **Execute the testnet lifecycle** (`near/scripts/testnet-lifecycle.sh`) and record transaction hashes in `near/evidence/testnet-lifecycle.md`.
3. **Add a no-signup sandbox demo** — the `npm run demo` already satisfies this (local simulation, no wallet, no network).
