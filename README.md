# CALIPER — Verified labor market for autonomous agents

**Built for [NEAR HACKATHON 2026](https://nearhackathon.com/) — Track 05: AI Swarms**
**Deadline: November 14, 2026 at 23:59 UTC**

**A coding agent can make its CI green by weakening the tests. CALIPER makes that manipulation detectable and keeps payment locked until independent acceptance.**

CALIPER is a verified labor market for autonomous agents. Workers compete for tasks, but a worker cannot define its own success, certify its own deliverable, or trigger its own payment. A separate verifier evaluates the exact submitted artifact against acceptance criteria pinned before work began. A NEAR contract escrows the coordinator's maximum budget and, once verification passes, pays the worker exactly the winning bid.

> Work is not payable merely because an agent reports success.

## Status and limits (read this first)

- **The market is an off-chain simulation.** Bids and winner selection happen in `demo/market.ts`. The contract records the supplied transcript hash, the selected worker, the escrowed budget, and the winning bid. It does **not** run an auction or independently select a winner.
- **The testnet deployment is verified; the testnet lifecycle is not.** `caliper.testnet` exists, its bytecode is deployed, and `init` executed. On-chain state currently shows `get_root = null`, `get_total_allocated = "0"`, and `list_jobs = []`. No job, verification, or payment has run on testnet.
- **The deployed bytecode predates the fixes in this working tree.** The deployment proves tooling and initialization, not the corrected settlement semantics described below. Redeploy before claiming on-chain lifecycle behavior.
- **Runner isolation is limited by default.** The default mode is a process wrapper with a scrubbed environment and timeout, not a security boundary. `CALIPER_SANDBOX=os` opts into a fail-closed macOS/Linux OS sandbox.
- **The lifecycle demonstrated by `npm run demo` is a local simulation.** It is not a chain of testnet transactions.

## Why this exists (the silent failure mode)

A coordinator hires an AI coding agent to fix an authorization bug. The agent cannot fix the bug, so it deletes the failing test, weakens an assertion, or disables the CI check. Its branch turns green. The coordinator sees success and is about to pay.

The agent has not fixed the software. It has **fixed the measurement of its own performance**.

This is the silent failure mode every agent-economy sponsor loses sleep over: agents that look productive but quietly degrade trust. CALIPER makes that manipulation detectable and keeps payment locked until independent acceptance.

## The complete loop (local simulation)

```
Owner -> Coordinator -> five deterministic commit/reveal bids -> off-chain selection
      -> selected worker submits artifact hash
      -> independent verifier computes diff + runs pinned suite
      -> signed artifact-bound attestation (Ed25519)
      -> Verified: payment becomes a fixed obligation
      -> any account releases payment -> NEAR PaymentPending
      -> transfer callback -> Paid (exactly the winning bid)
```

If the first attempt is tampered, the job becomes `Rejected`, the coordinator requests changes, and the **same selected worker** gets one correction attempt. There is no silent switch to another worker.

## Economic rules

- The coordinator escrows its **maximum budget** when the job is created.
- The worker is paid **exactly the winning bid** recorded at creation.
- The unused remainder returns to the coordinator's available allocation on settlement.
- Once verification passes, the payment obligation is fixed. `release_verified_payment` is permissionless: the worker, verifier, or any third party may call it.
- A `Verified` job cannot be cancelled. The coordinator cannot revoke the branch to escape the obligation.
- A `Submitted` job can be cancelled by the coordinator only after `VERIFICATION_TIMEOUT_BLOCKS` (1,000 blocks) without a verdict, so a stalled verifier cannot lock escrow forever.

## What is enforced

| Guarantee | Meaning |
|-----------|---------|
| Authority attenuation | A child cannot acquire permissions, recipients, assets, or spending limits its parent does not possess. Only native NEAR is payable. |
| Commitment isolation | Committed funds cannot be spent twice; exhausted or cancelled jobs release unused commitments. |
| Branch revocation | Revoking a parent invalidates every descendant. Unrelated branches survive; budget already spent is not reissued. |
| Revocation cannot orphan obligations | A branch with an outstanding verified payment, or a job awaiting verification, cannot be revoked. |
| Genuine role separation | Coordinator, worker, and verifier need distinct authority nodes **and** distinct NEAR account holders. |
| Worker cannot self-certify | `submit_deliverable` accepts only an artifact hash. The worker cannot supply diff or tampering claims. |
| Artifact-bound evidence | Verifier signs job ID, attempt, deliverable hash, criteria, baseline, acceptance policy, diff, artifact-match flag, protected-file result, test/CI exit codes, runner version, outcome. |
| No stale verification | Every submission increments the attempt and clears previous evidence. A success cannot authorize a later artifact. |
| Truthful settlement | `PaymentPending` is not `Paid`. Only a successful transfer callback moves the job to `Paid`. |
| Exact payment | The transfer amount is `winning_bid`, not the escrowed maximum budget. |

## Live deployment (NEAR testnet)

| Item | Value |
|------|-------|
| Contract | `caliper.testnet` |
| Network | NEAR Testnet |
| Deployment transaction | `HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z` |
| Transaction status | `FINAL` |
| Actions | `DeployContract` + `FunctionCall` (`init`) |
| Signer / receiver | `caliper.testnet` / `caliper.testnet` |
| Deployed code hash | `Hst7gb5bXE4DoY99CgbrG2McRGBm41LkUKodpF7Fc2Bh` |
| Balance | 9,997.3034170156228 NEAR |
| Explorer | https://testnet.nearblocks.io/txns/HkwyEMPrVctq46oeC55D67onStJC2DtNQ3TZ97hYUL6z |

Verified view results at the time of writing:

| View | Result |
|------|--------|
| `get_owner` | `"caliper.testnet"` |
| `get_root` | `null` |
| `get_total_allocated` | `"0"` |
| `list_jobs` | `[]` |

**Interpretation:** the account, bytecode, and `init` are real. The job lifecycle is not. See `near/evidence/testnet-lifecycle.md` for the exact evidence boundary and `near/scripts/testnet-lifecycle.sh` for an executable lifecycle procedure that has **not** been run.

## Prior work

**Prior work:** The adversarial test suite (21 off-chain tests), the formal model (41 contract tests), and the canonical attestation format predate the hackathon. The testnet deployment, recorded scenario, and independent verification fixtures were completed during the event window. All commit metadata is `HillaryIkhais <ikhaishillary@gmail.com>`. The `docs/hackathon-proof-and-narrative.md` document provides a full proof table and claim-audit labeling for judge review.

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

### 2. Verify the live testnet deployment (no wallet needed)

```bash
near view caliper.testnet get_owner
near view caliper.testnet get_total_allocated
near state caliper.testnet
```

These confirm deployment and initialization. They do not confirm a job lifecycle.

### 3. Run the contract and off-chain test suites

```bash
npm test          # contract tests + off-chain tests
npm run verify    # exported-state fixtures
```

### 4. Open the workbench

```bash
npm run serve
# http://127.0.0.1:4317
```

## Runner isolation

`demo/runner.ts` executes the pinned test and CI commands. Separation is reported explicitly in every `VerificationReport`.

| Mode | Selection | Filesystem | Network | Honest claim |
|------|-----------|------------|---------|--------------|
| Default | unset / `CALIPER_SANDBOX=none` | shared | shared | Process wrapper only: scrubbed env, fixed cwd, 15s timeout. **Not** a security boundary. |
| OS sandbox | `CALIPER_SANDBOX=os` | confined to job workspace + scratch | denied | macOS `sandbox-exec` or Linux `bwrap`. Fails closed if unavailable. |

Run the demo under the OS sandbox with:

```bash
CALIPER_SANDBOX=os npm run demo
```

The demo does not execute arbitrary untrusted repositories. The acceptance suite is a controlled fixture.

## Sponsor fit: NEAR AI Swarms track

CALIPER directly addresses Track 05 — "Many agents. One economy. Build coordination markets, bidding, collective purchasing, intent-based settlement between agents."

- **Coordination market**: Five deterministic workers submit commit/reveal bids in an off-chain simulation; the lowest valid bid is selected.
- **Collective purchasing**: The coordinator allocates budget from its authority tree; job escrow isolates funds and returns the unused remainder.
- **Intent-based settlement**: The worker submits an artifact hash; the verifier signs an attestation; NEAR releases exactly the winning bid only on confirmed settlement.

## Repository layout

```
contract/src/lib.rs              NEAR contract: authority, jobs, attestations, payment lifecycle
contract/verify/verify.ts        exported-state auditor
contract/verify/sample-*.json    valid and invalid state fixtures
shared/attestation.ts            canonical attestation, digest, Ed25519 sign/verify
shared/attestation-vector.json   cross-language Rust/TypeScript canonical vector
demo/fixture/                    pinned baseline, acceptance suite, protected CI, submissions
demo/runner.ts                   independent diff + test runner + signed report
demo/market.ts                   deterministic off-chain commit/reveal market simulation
demo/local-chain.ts              local simulation mirroring contract transitions
demo/swarm.ts                    end-to-end adversarial coordinator
demo/cli.ts                      one-command demo
demo/server.ts                   local workbench API
near/scripts/testnet-lifecycle.sh  runnable, unexecuted testnet lifecycle procedure
near/evidence/testnet-lifecycle.md evidence boundary and reproduction steps
web/                             focused product interface
RULES.md                         economic and trust rules
JUDGES.md                        judge's shortest path
HACKATHON.md                     NEAR hackathon submission guide
SUBMISSION.md                    submission status and evidence boundary
```

## Contract methods

- `init(owner)` — initialize contract with owner account
- `create_root(holder, allocation, permissions)` — create root authority node
- `delegate(parent, holder, permissions, allocation, expiry)` — attenuated child authority
- `spend(node, recipient, amount, asset)` — NEAR spend with policy checks
- `revoke(node)` — revoke a node and all descendants transitively; blocked while an obligation is outstanding
- `on_payout(execution_id, amount)` — private settlement callback
- `create_job(..., budget, winning_bid, ...)` — pin acceptance and record the off-chain selection, escrowed max budget, and winning bid
- `submit_deliverable(job, deliverable_hash)` — worker submits artifact hash only
- `record_independent_verification(job, attestation)` — verifier signs artifact-bound evidence
- `request_changes(job)` — coordinator opens one correction attempt
- `accept_job(job)` — coordinator convenience path to initiate settlement
- `release_verified_payment(job)` — permissionless settlement once verification has passed
- `cancel_job(job)` — cancel `Open`/`Rejected`, or `Submitted` after the verification timeout; never `Verified`
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
cd contract && cargo test
npm run test:node
npm run verify
cd contract && cargo build --release --target wasm32-unknown-unknown
```

## NEAR deployment path

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown
near deploy <your-testnet-account> target/wasm32-unknown-unknown/release/caliper.wasm \
  --initFunction init --initArgs '{"owner":"<your-testnet-account>"}'
```

Then create the role tree, pin the verifier public key, and call `create_job` with the hashes the runner produces, the escrowed maximum budget, and the winning bid.

## Deadline

November 14, 2026 at 23:59 UTC — NEAR HACKATHON 2026 submission closes.
