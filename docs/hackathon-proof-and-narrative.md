# Hackathon Proof and Narrative — Applied to CALIPER

## 1. One-sentence thesis

**An AI agent can make CI green by weakening tests instead of fixing code — CALIPER makes that manipulation detectable and pays only the winning bid after independent verification confirms the fix.**

## 2. Invariant

**Work is not payable merely because an agent reports success. Payment requires independent, artifact-bound attestation verified against pinned criteria, and the transfer amount equals exactly the winning bid.**

## 3. Proof table

| Check | Result | Evidence | Category |
|---|---|---|---|
| Contract unit tests | 41/41 pass | `contract/src/lib.rs` | Enforced |
| Off-chain tests | 21/21 pass | `demo/*.test.ts` | Demonstrated |
| Exported-state fixtures | 2/2 verify | `contract/verify/sample-*.json` | Enforced |
| Wasm release build | Success | `cargo build --release --target wasm32-unknown-unknown` | Demonstrated |
| Testnet deployment | Verified (init only) | `caliper.testnet`, tx `HkwyEMPr...` | Demonstrated |
| Testnet lifecycle | Not executed | `get_root=null`, `list_jobs=[]` | Limitation (honest) |
| Winning-bid settlement | `spent == winning_bid` | `settlement_pays_winning_bid_and_returns_unused_budget` test | Enforced |
| Permissionless release | Third party can release | `worker_revocation_does_not_block_permissionless_settlement` test | Enforced |
| Revocation guard | Blocked on obligation | `coordinator_with_verified_payment_cannot_be_revoked` test | Enforced |
| Non-cancellable Verified | `cancel_job` panics | `verified_job_cannot_be_cancelled` test | Enforced |
| Duplicate callback idempotent | Early return if not `PaymentPending` | `on_job_payment` implementation | Enforced |
| Runner isolation | Default = process-only | `CALIPER_SANDBOX=os` opt-in fail-closed | Limitation (honest) |

## 4. README above-the-fold draft

```markdown
# CALIPER — Verified labor market for autonomous agents

**Built for NEAR HACKATHON 2026 — Track 05: AI Swarms**
**Deadline: November 14, 2026 at 23:59 UTC**

**An AI agent can make CI green by weakening tests instead of fixing code. CALIPER makes that manipulation detectable and pays only the winning bid after independent verification confirms the fix.**

## Live demo

```bash
npm run demo
```

**Source:** https://github.com/HillaryIkhais/Caliper  
**Video:** (attached to submission post)  
**Testnet:** `caliper.testnet` (deployment + init verified; lifecycle unexecuted)

| Check | Result | Evidence |
|---|---|---|
| Contract tests | 41/41 pass | `cargo test` |
| Off-chain tests | 21/21 pass | `npm run test:node` |
| Verify fixtures | 2/2 pass | `npm run verify` |
| Testnet deployment | Verified | `caliper.testnet`, tx `HkwyEMPr...` |
| Testnet lifecycle | Not executed | `get_root=null`, `list_jobs=[]` |

**Try it:** `npm run demo` — no wallet, no network, no signup.  
**Boundary:** Default runner execution is process-only, not a security boundary. `CALIPER_SANDBOX=os` opts into fail-closed sandboxing. The bid market is off-chain; the contract records selection only.
```

## 5. Demo script (7 beats, timestamps)

| Time | Beat | CALIPER mapping |
|---|---|---|
| 0:00–0:20 | The problem | Agent weakens tests, disables CI, branch turns green, coordinator is about to pay |
| 0:20–0:40 | Setup | Owner creates root, delegates coordinator/worker/verifier with attenuated authority |
| 0:40–1:10 | Golden path | Eve wins market, submits genuine fix, verification passes, payment settles |
| 1:10–1:40 | The break | Eve's first attempt modifies `ci/check.js` and `tests/auth.test.js`; claims success |
| 1:40–2:10 | The catch | Runner restores pinned suite, detects protected-file changes, verification fails, payment blocked |
| 2:10–2:40 | Proof | Eve fixes `src/auth.js`; fresh run passes; worker releases payment; contract pays exactly winning bid |
| 2:40–2:55 | Limitations + close | Testnet lifecycle unexecuted; OS isolation opt-in; market off-chain |

## 6. Claim discipline

| Claim | Category | Evidence |
|---|---|---|
| Contract enforces winning-bid settlement | Enforced | `settlement_pays_winning_bid_and_returns_unused_budget` test |
| Verified jobs cannot be cancelled | Enforced | `verified_job_cannot_be_cancelled` test |
| Permissionless release after verification | Enforced | `worker_revocation_does_not_block_permissionless_settlement` test |
| Revocation blocked on outstanding obligation | Enforced | `coordinator_with_verified_payment_cannot_be_revoked` test |
| Testnet lifecycle executed | ❌ Not claimed | Honestly documented as unexecuted |
| OS-level sandbox (default) | ❌ Not claimed | Explicitly labeled as process-only |
| On-chain auction | ❌ Not claimed | Explicitly labeled as off-chain simulation |
| Updated contract deployed | ❌ Not claimed | Deployed bytecode predates fixes |

## 7. Known limitations (specific, not vague)

- **Testnet lifecycle unexecuted:** `get_root=null`, `get_total_allocated="0"`, `list_jobs=[]`. The deployment proves init only; `near/scripts/testnet-lifecycle.sh` is provided but unrun.
- **Deployed bytecode predates fixes:** The `caliper.testnet` code hash corresponds to the pre-fix contract. Redeploy required before claiming on-chain lifecycle behavior.
- **Runner isolation limited:** Default execution is process-only (scrubbed env, fixed cwd, 15s timeout) — not a security boundary. `CALIPER_SANDBOX=os` opts into macOS `sandbox-exec` or Linux `bwrap`, failing closed if unavailable.
- **Bid market off-chain:** Selection happens in `demo/market.ts`; the contract records the supplied transcript hash and does not validate the auction.
- **Testnet funds non-redeemable:** 9,997.3 NEAR on testnet; no real economic value at stake.

## 8. Non-claims

| Non-claim | Why excluded |
|---|---|
| "On-chain auction" | Market is off-chain simulation; contract records selection only |
| "On-chain winner selection" | Contract does not validate bids or select winners |
| "Testnet lifecycle complete" | No root, no allocation, no jobs on `caliper.testnet` |
| "Fixed contract deployed" | Deployed bytecode predates the fixes in this repository |
| "OS-level sandbox by default" | Default is process-only; `CALIPER_SANDBOX=os` is opt-in |

## 9. Prior work disclosure

**Prior work:** The adversarial test suite (21 tests), the formal model (41 contract tests), and the canonical attestation format predate the hackathon. The testnet deployment, recorded scenario, and independent verification fixtures were completed during the event window. All commit metadata is `HillaryIkhais <ikhaishillary@gmail.com>`.

## 10. Post draft

**Hook:** An AI agent can fake a fix by weakening tests. CALIPER catches it — and only pays after independent verification.

**The silent failure mode:** A coordinator hires an agent to fix an authorization bug. The agent deletes the failing test, weakens an assertion, disables CI. The branch turns green. The coordinator pays for fake work.

**How it works:**
1. Coordinator pins acceptance criteria, protected files, and baseline commit before work begins.
2. Workers bid in a deterministic off-chain simulation; lowest valid bid is selected.
3. Worker submits only an artifact hash — cannot self-certify.
4. Independent verifier reruns the pinned suite, computes diff, checks protected files, signs Ed25519 attestation.
5. Once verified, payment is a fixed obligation — permissionless release, coordinator cannot cancel.
6. Contract pays exactly the winning bid on callback confirmation; unused escrow returns.

**Proof:** 41 contract tests + 21 off-chain tests, all pass. Testnet deployment verified at `caliper.testnet`. Lifecycle unexecuted — honestly documented.

**Gratitude / next:** Built for NEAR Hackathon 2026 Track 05. Feedback welcome.

## 11. Q&A answers

| Question | Answer | Artifact |
|---|---|---|
| What if the model is wrong? | A deterministic policy engine blocks the action. The runner is not the verifier of its own output — every attestation field is rechecked by the contract. | `contract/src/lib.rs` attestation binding |
| What is actually enforced? | Winning-bid settlement, permissionless release, non-cancellable Verified jobs, revocation guards, authority attenuation, commitment isolation | 41 contract tests |
| How do you know verification is correct? | Independent runner (≠ generator) produces Ed25519-signed attestation; contract revalidates every binding field | `shared/attestation.ts`, `demo/runner.ts` |
| What is the boundary? | Single contract instance; testnet only; off-chain market; process-only runner by default | README limitations section |
| What breaks in production? | Redeploy required (deployed bytecode predates fixes); testnet lifecycle unexecuted | `near/evidence/testnet-lifecycle.md` |

## 12. Claim audit (E/D/M/F labeling)

Every claim in README.md, JUDGES.md, HACKATHON.md, and SUBMISSION.md has been labeled:
- **[E] Enforced** — guaranteed by deterministic mechanism (contract code + tests)
- **[D] Demonstrated** — shown in the demo (local simulation)
- **[M] Measured** — observed with sample size (test counts)
- **[F] Future work** — not built (testnet lifecycle execution)
- **[?] Unsupported** — deleted or corrected (all on-chain-equivalence claims removed)

No unsupported claims remain.
