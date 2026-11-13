# CALIPER — Verified labor market for autonomous agents

**A coding agent can make its CI green by weakening the tests. CALIPER makes that manipulation detectable and keeps payment locked until independent acceptance.**

CALIPER is a verified labor market for autonomous agents. Workers compete for tasks, but a
worker cannot define its own success, certify its own deliverable, or trigger its own
payment. A separate verifier evaluates the exact submitted artifact against acceptance
criteria pinned before work began. A NEAR contract holds the budget and releases payment
only after confirmed settlement.

> Work is not payable merely because an agent reports success.

Primary track: **Open Innovation**. Secondary track: **AI Swarms**.

## The failure CALIPER prevents

A coordinator hires an AI coding agent to fix an authorization bug. The agent cannot fix the
bug, so it deletes the failing test, weakens an assertion, or disables the CI check. Its
branch turns green. The coordinator sees success and is about to pay.

The agent has not fixed the software. It has **fixed the measurement of its own performance**.

CALIPER detects that the worker modified the measurement, blocks payment, and gives the
worker one controlled correction attempt. The verifier reruns the original pinned suite
against the corrected source. Only then can the coordinator approve settlement.

## The complete loop

```
Owner -> Coordinator -> five deterministic commit/reveal bids -> deterministic selection
      -> selected worker submits artifact
      -> independent verifier computes diff + runs pinned suite
      -> signed artifact-bound attestation
      -> coordinator approval gate
      -> NEAR PaymentPending -> callback -> Paid
```

If the first attempt is tampered, the job becomes `Rejected`, the coordinator requests
changes, and the **same selected worker** gets one correction attempt. There is no silent
switch to another worker.

## What is enforced

| Guarantee | Meaning |
|---|---|
| Authority attenuation | A child cannot acquire permissions, recipients, assets, or spending limits its parent does not possess. Only native NEAR is payable; non-NEAR asset arguments are rejected. |
| Commitment isolation | Committed funds cannot be spent twice; exhausted or cancelled jobs release unused commitments. |
| Branch revocation | Revoking a parent invalidates every descendant. Unrelated branches survive, and budget already spent by the revoked branch is not reissued. |
| Genuine role separation | Coordinator, worker, and verifier need distinct authority nodes **and** distinct NEAR account holders. |
| Worker cannot self-certify | `submit_deliverable` accepts only an artifact hash. The worker cannot supply diff or tampering claims. |
| Artifact-bound evidence | The verifier signs job ID, attempt, claimed artifact, criteria, baseline, acceptance policy, diff, artifact-match flag, protected-file result, separate test and CI exit codes, runner version, and outcome. A hash mismatch is recorded as a normal failed attempt. |
| No stale verification | Every submission increments the attempt and clears all previous evidence. A success cannot authorize a later artifact. |
| Truthful settlement | `PaymentPending` is not `Paid`. Only a successful transfer callback moves the job to `Paid`; retries cannot double-pay. |

The acceptance-policy hash pins the complete verification policy: the manifest, acceptance
criteria, full baseline tree hash, baseline commit, test and CI commands, protected paths, and
every protected file. The baseline commit is a real deterministic git commit SHA derived from
the fixture tree, not a label. The runner recreates that commit, checks it against the pinned
SHA, recomputes the policy from disk, and rechecks the criteria hash before it signs. A
mismatch aborts verification instead of producing an attestation.

The contract verifies the authorized verifier's Ed25519 signature over a canonical
attestation. The off-chain runner performs the test execution and diff computation. The
contract does **not** execute arbitrary code and does **not** mathematically prove software
correctness. The trust model is explicit: an independent verifier key pinned at job creation,
bound to exact evidence, with the actual report independently inspectable.

**Execution boundary:** the runner copies the candidate into a temporary directory, strips the
host environment, and applies a timeout. It does **not** provide an OS sandbox, filesystem
jail, or network isolation. It is intentionally limited to the controlled fixture in this
repository and must not be used to execute arbitrary untrusted repositories.

See [`RULES.md`](RULES.md) for the full economic rules, trust boundaries, and state machine.

## Judge path

No wallet, network, model API, or package install is required. Node 22.18+ and Rust are the
only prerequisites.

```bash
# 1. Run the complete adversarial demonstration.
npm run demo

# 2. Run the contract and off-chain test suites.
npm test

# 3. Open the workbench.
npm run serve
# http://127.0.0.1:4317
```

The demo prints the market transcript, the blocked attempt, the computed manipulation
evidence, the correction, and the final local-simulation receipt. It exits non-zero if the
scenario does not reach verified settlement.

## What the demo shows

The fixture is a small authorization project with a real bug:

- `src/auth.js` lets every authenticated member access billing.
- `tests/auth.test.js` and `ci/check.js` are pinned and protected before work begins.

Five deterministic workers submit commit/reveal bid commitments. Nonces are derived
deterministically for reproducibility, so this is a simulation of the mechanics, not a
private or trustless sealed-bid auction. One reveal is invalid, one is late, and one
duplicate commitment is rejected. The lowest valid bid selects the deliberately adversarial
worker (`worker-eve.local`). The contract records the supplied transcript hash, but it does
not independently validate the auction or prove the winner.

Attempt 1:

- Eve weakens the billing assertion and disables the CI check.
- Eve claims success.
- CALIPER independently computes the diff, detects protected-file changes, restores the
  pinned suite, and reruns it against the actual source.
- Verification fails. Payment is blocked. The job is `Rejected`.

Attempt 2:

- The coordinator requests correction; the same worker remains assigned.
- Eve fixes `src/auth.js` without touching the measurement.
- The runner executes the original pinned test and CI files.
- Verification passes. The coordinator approves.
- Local chain moves `Verified -> PaymentPending -> Paid` through the settlement callback.

Every identity, report, and receipt is labeled **local simulation**. The workbench never
invents a transaction hash or an on-chain settlement.

## Repository layout

```
contract/src/lib.rs              NEAR contract: authority, jobs, attestations, payment lifecycle
contract/verify/verify.ts        exported-state auditor (authority, attenuation, jobs, evidence binding)
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
```

## Contract methods

- `init(owner)`
- `create_root(holder, allocation, permissions)`
- `delegate(parent, holder, permissions, allocation, expiry)`
- `spend(node, recipient, amount, asset)`
- `revoke(node)`
- `on_payout(execution_id, amount)` — private settlement callback
- `create_job(coordinator, worker, verifier, verifier_public_key, budget,
  acceptance_criteria_hash, acceptance_suite_hash, baseline_commit,
  market_transcript_hash, protected_files)`
- `submit_deliverable(job, deliverable_hash)`
- `record_independent_verification(job, attestation)`
- `request_changes(job)`
- `accept_job(job)`
- `on_job_payment(job)` — private settlement callback
- `cancel_job(job)`

Views include `get_node`, `get_root`, `get_available`, `is_valid`, `get_execution`,
`list_executions`, `list_revocations`, `get_job`, `get_job_verification`, `list_jobs`, and
`get_total_allocated` (cumulative allocation granted, not the current unlocked balance).

## Verification evidence

The canonical attestation body is identical in Rust and TypeScript:

```
caliper-attestation-v2|job_id|attempt|deliverable_hash|acceptance_criteria_hash|
baseline_commit|acceptance_suite_hash|diff_hash|deliverable_matches_claim|
protected_files_clean|test_exit_code|ci_exit_code|runner_version|passed
```

The report digest is `sha256:` over that body. The Ed25519 signature covers
`body|report_digest|verifier_public_key`. The contract rejects an attestation for a different
job, artifact, attempt, criteria, baseline, acceptance policy, or key, and rejects an invalid signature
or inconsistent outcome. `shared/attestation-vector.json` is asserted by both the Rust test
and the TypeScript suite.

## Tests

```bash
cd contract && cargo test          # 39 contract tests
npm run test:node                  # 20 market, runner, and end-to-end tests
npm run verify                     # exported-state fixtures
cd contract && cargo build --release --target wasm32-unknown-unknown  # ~331 KB wasm artifact
```

Contract tests cover role separation, same-account/different-node rejection, revoked roles,
wrong artifact/criteria/signature, old-attempt replay, stale-success prevention, retry
exhaustion and commitment release, pending payment, failed transfer, idempotent settlement,
revocation that retains already-spent or pending budget, a recorded hash-mismatch failure,
native-NEAR-only spends, verified-job cancellation after role revocation, and the existing
authority/commitment/revocation guarantees.

Runner tests cover a genuine fix, a deleted protected test, a weakened assertion, a disabled
CI check, suite restoration, old-report replay, a mutated baseline commit, protected-file
renames, and node_modules exclusion. Market tests cover duplicate commitments, invalid and
late reveals, deterministic selection, tie-breaking, invalid-bid exclusion, transcript
reproducibility, and the explicit non-private simulation label.

## NEAR deployment path

The contract is the enforcement and settlement layer. This repository ships a reproducible
local simulation because no testnet deployment credentials are committed. To deploy:

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown
near deploy <your-testnet-account> target/wasm32-unknown-unknown/release/caliper.wasm \
  --initFunction init --initArgs '{"owner":"<your-testnet-account>"}'
```

Then create the role tree, pin the verifier public key, and call `create_job` with the same
hashes the runner produces. Never commit private keys or wallet secrets. The UI is
deliberately explicit about whether it is showing local simulation or a connected testnet.

## Deadline

November 14, 2026 at 23:59 UTC.
