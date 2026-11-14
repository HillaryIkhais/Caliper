# CALIPER — Verified labor market for autonomous agents

**Built for [NEAR HACKATHON 2026](https://nearhackathon.com/) — Track 05: AI Swarms**
**Deadline: November 14, 2026 at 23:59 UTC**

**A coding agent can make its CI green by weakening the tests. CALIPER makes that manipulation detectable and keeps payment locked until independent acceptance.**

CALIPER is a verified labor market for autonomous agents. Workers compete for tasks, but a worker cannot define its own success, certify its own deliverable, or trigger its own payment. A separate verifier evaluates the exact submitted artifact against acceptance criteria pinned before work began. A NEAR contract holds the budget and releases payment only after confirmed settlement.

> Work is not payable merely because an agent reports success.

## Why this exists (the silent failure mode)

A coordinator hires an AI coding agent to fix an authorization bug. The agent cannot fix the bug, so it deletes the failing test, weakens an assertion, or disables the CI check. Its branch turns green. The coordinator sees success and is about to pay.

The agent has not fixed the software. It has **fixed the measurement of its own performance**.

This is the silent failure mode every agent-economy sponsor loses sleep over: agents that look productive but quietly degrade trust. CALIPER makes that manipulation detectable and keeps payment locked until independent acceptance.

## The complete loop

```
Owner -> Coordinator -> five deterministic commit/reveal bids -> deterministic selection
      -> selected worker submits artifact hash
      -> independent verifier computes diff + runs pinned suite
      -> signed artifact-bound attestation (Ed25519)
      -> coordinator approval gate
      -> NEAR PaymentPending -> transfer callback -> Paid
```

If the first attempt is tampered, the job becomes `Rejected`, the coordinator requests changes, and the **same selected worker** gets one correction attempt. There is no silent switch to another worker.

## What is enforced

| Guarantee | Meaning |
|-----------|---------|
| Authority attenuation | A child cannot acquire permissions, recipients, assets, or spending limits its parent does not possess. Only native NEAR is payable. |
| Commitment isolation | Committed funds cannot be spent twice; exhausted or cancelled jobs release unused commitments. |
| Branch revocation | Revoking a parent invalidates every descendant. Unrelated branches survive; budget already spent is not reissued. |
| Genuine role separation | Coordinator, worker, and verifier need distinct authority nodes **and** distinct NEAR account holders. |
| Worker cannot self-certify | `submit_deliverable` accepts only an artifact hash. The worker cannot supply diff or tampering claims. |
| Artifact-bound evidence | Verifier signs job ID, attempt, deliverable hash, criteria, baseline, acceptance policy, diff, artifact-match flag, protected-file result, test/CI exit codes, runner version, outcome. |
| No stale verification | Every submission increments the attempt and clears previous evidence. A success cannot authorize a later artifact. |
| Truthful settlement | `PaymentPending` is not `Paid`. Only a successful transfer callback moves the job to `Paid`. |

## Live deployment (NEAR testnet)

| Item | Value |
|------|-------|
| Contract | `caliper.testnet` |
| Network | NEAR Testnet |
| Transaction | `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z` |
| Explorer | https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z |
| WASM SHA-256 | `fac3d3d2c2a4ca206085b96e6ddb9223a4bb8b4d8882ef19cd5dba717593c0a8` |

The live testnet contract shows identical state transitions with actual NEAR settlement. Every identity, report, and receipt labeled **local simulation** in this repo corresponds to real on-chain state transitions on testnet.

## How to run (judge path)

### 1. Run the complete adversarial demonstration (no wallet, no network)

```bash
npm run demo
```

Expected key output:
```
attempt 1: Rejected — blocked: protected acceptance files were modified
  protected violations: M ci/check.js, M tests/auth.test.js
attempt 2: Verified — passed: genuine source fix accepted by the pinned suite
payment: Paid (Local chain simulation ...)
```

### 2. Verify the live testnet contract

```bash
# Check total allocation (view call, no wallet needed)
near view caliper.testnet get_total_allocated

# Check the contract is deployed
near state caliper.testnet
```

### 3. Run the contract and off-chain test suites

```bash
npm test          # 39 contract tests + 20 off-chain tests
npm run verify    # exported-state fixtures
```

### 4. Open the workbench

```bash
npm run serve
# http://127.0.0.1:4317
```

## Sponsor fit: NEAR AI Swarms track

CALIPER directly addresses Track 05 — "Many agents. One economy. Build coordination markets, bidding, collective purchasing, intent-based settlement between agents."

- **Coordination market**: Five deterministic workers submit commit/reveal bids; lowest valid bid wins.
- **Collective purchasing**: Coordinator allocates budget from its authority tree; job commitment isolates funds.
- **Intent-based settlement**: Worker submits artifact hash; verifier signs attestation; NEAR releases payment only on confirmed settlement.

## Repository layout

```
contract/src/lib.rs              NEAR contract: authority, jobs, attestations, payment lifecycle
contract/verify/verify.ts        exported-state auditor
contract/verify/sample-*.json    valid and invalid state fixtures
shared/attestation.ts            canonical attestation, digest, Ed25519 sign/verify
shared/attestation-vector.json   cross-language Rust/TypeScript canonical vector
demo/fixture/                    pinned baseline, acceptance suite, protected CI, submissions
demo/runner.ts                   independent diff + test runner + signed report
demo/market.ts                   deterministic commit/reveal market simulation
demo/local-chain.ts              local simulation mirroring contract transitions
demo/swarm.ts                    end-to-end adversarial coordinator
demo/cli.ts                      one-command demo
demo/server.ts                   local workbench API
web/                             focused product interface
RULES.md                         economic and trust rules
JUDGES.md                        judge's shortest path
HACKATHON.md                     NEAR hackathon submission guide
SUBMISSION.md                    testnet deployment evidence
```

## Contract methods

- `init(owner)` — initialize contract with owner account
- `create_root(holder, allocation, permissions)` — create root authority node
- `delegate(parent, holder, permissions, allocation, expiry)` — attenuated child authority
- `spend(node, recipient, amount, asset)` — NEAR spend with policy checks
- `revoke(node)` — revoke a node and all descendants transitively
- `on_payout(execution_id, amount)` — private settlement callback
- `create_job(...)` — create a verified labor market job with pinned acceptance
- `submit_deliverable(job, deliverable_hash)` — worker submits artifact hash only
- `record_independent_verification(job, attestation)` — verifier signs artifact-bound evidence
- `request_changes(job)` — coordinator opens one correction attempt
- `accept_job(job)` — coordinator approves verified work, initiates NEAR payment
- `on_job_payment(job)` — private settlement callback (only path to `Paid`)

## Verification evidence

The canonical attestation body is identical in Rust and TypeScript:

```
caliper-attestation-v2|job_id|attempt|deliverable_hash|acceptance_criteria_hash|
baseline_commit|acceptance_suite_hash|diff_hash|deliverable_matches_claim|
protected_files_clean|test_exit_code|ci_exit_code|runner_version|passed
```

## Tests

```bash
cd contract && cargo test          # 39 contract tests
npm run test:node                  # 20 market, runner, and end-to-end tests
npm run verify                     # exported-state fixtures
cd contract && cargo build --release --target wasm32-unknown-unknown  # ~331 KB wasm artifact
```

## NEAR deployment path

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown
near deploy <your-testnet-account> target/wasm32-unknown-unknown/release/caliper.wasm \
  --initFunction init --initArgs '{"owner":"<your-testnet-account>"}'
```

Then create the role tree, pin the verifier public key, and call `create_job` with the same hashes the runner produces.

## Deadline

November 14, 2026 at 23:59 UTC — NEAR HACKATHON 2026 submission closes.