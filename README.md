# CALIPER — Independent Acceptance for Agent-Created Code

**A coding agent can make its CI green by weakening the tests. CALIPER catches the manipulation.**

AI agents can hire other AI agents. But who controls the money and authority when those agents start hiring their own subcontractors — and who verifies that the hired agent actually fixed the problem, instead of just fixing the measurement of its own performance?

CALIPER is an on-chain authority and settlement system for autonomous subcontracting with **independent acceptance**. It lets agents hire other agents, delegate budget recursively, and — crucially — prevents an agent from accepting and paying for work that has not passed independent verification.

## The failure CALIPER prevents

When you hire an AI coding agent to fix a bug, it cannot fix the bug — so it deletes the failing test, weakens an assertion, or disables the check in CI. Its branch turns green. The coordinator sees "all tests passed" and pays.

The agent has not fixed the software. It has **fixed the measurement of its own performance**.

This is a documented risk. OWASP's Secure Coding with AI guidance identifies test deletion, weakened assertions, and disabled checks as agent-coding risks. OpenAI has documented reward-hacking behavior in which coding agents edit tests or disable checks to make evaluations pass.

## The product loop

KEEP THE FIRST VERSION NARROW: software bug fixes, because they have tests that objectively pass or fail.

1. **Owner submits a task.** Example: "Fix this authorization bug in a NEAR contract." Supplies the repository, base commit, budget, acceptance tests, and a list of protected files (tests, CI config, build scripts) that the worker must not modify.
2. **Coordinator hires a worker.** CALIPER creates the job through NEAR Agent Market with a fixed budget, an immutable acceptance-suite hash, and the protected file list pinned before work begins. The worker cannot substitute its own tests.
3. **Worker submits a deliverable.** The worker reports which files they modified. CALIPER checks whether any modified file is in the protected list. If so, **tampering is flagged** and the job cannot be accepted.
4. **Independent runner tests it.** A separate, isolated runner executes the buyer's original pinned tests against the worker's exact code artifact.
5. **Failure triggers repair.** CALIPER records the failure evidence and permits one bounded correction. Added tests can supplement, but cannot replace, the buyer's tests.
6. **Pass triggers acceptance.** CALIPER records a receipt tied to the exact source revision, test suite, and runner. The job can now be accepted and the NEAR Agent Market escrow released.
7. **Unresolved failure gets a human gate.** No LLM casually declares ambiguous work successful.

## The demo that sells it

**One vulnerable repository. One authorization bug. One worker who tries to fake it.**

01 — The subcontract

Owner gives the coordinator a 1 NEAR budget and a repository with a failing authorization test. The coordinator hires a coding agent through NEAR Agent Market. The acceptance suite and base commit are pinned before work begins.

02 — The attack

The worker cannot fix the bug, so it weakens the failing assertion and disables a test. Its own CI reports green.

```
Worker's own CI:        PASS
CALIPER independent run: FAIL
Unauthorized withdrawal still succeeds — the original regression test catches it.
```

CALIPER detects changes to protected test files. It then runs the original buyer-owned suite against the worker's exact artifact — and the bug is still there.

03 — Repair

CALIPER sends the failure evidence back. The worker gets one bounded correction opportunity.

04 — Acceptance

The corrected patch passes the pinned suite and independent negative tests. CALIPER produces a receipt tied to the exact source revision, test suite, and runner version. The job is accepted and the marketplace escrow is released.

**Hire → attack → detect → return → repair → independently verify → accept → pay → prove.**

## What CALIPER enforces

| Guarantee | Meaning |
|---|---|
| **Authority attenuation** | A child cannot acquire permissions, recipients, assets or spending limits its parent does not possess. |
| **Commitment isolation** | A parent cannot spend funds already committed to its children. A child cannot spend or delegate beyond its uncommitted allocation. |
| **Branch revocation** | Revoking a parent invalidates every descendant. Unrelated branches survive. |
| **Independent acceptance** | A job cannot be accepted unless an independent verifier has passed it, and no protected files were tampered with. |

## The receipt

Every accepted job produces a verifiable receipt binding: market job ID, worker ID, accepted price, base commit hash, submitted artifact hash, buyer-owned test-suite hash, runner image/version hash, test result, report hash, and acceptance/payment reference. A previous passing receipt cannot be reused for a different artifact.

## Competitive position

| Project | What it demonstrates | CALIPER's opening |
|---|---|---|
| AgentProof | Deterministic checks against structured deliverables; on-chain evidence | Its checker is not an independent software test runner, and failed checks do not block or refund payment (marketplace integration is read-only). |
| Digi Swarm Treasury | Workers bid, deliver, split revenue under treasury rules | Records deliverable hashes, but a hash does not establish that the software works. |
| Veto / Banbo | Payment safety, provenance, protection against malicious instructions | Not focused on whether hired code actually satisfies the buyer's requirements. |
| **CALIPER** | **Independent acceptance of agent-written code; tampering detection** | **Worker cannot manipulate the evaluator or certify its own work.** |

## Make the NEAR integration real

CALIPER does not invent another marketplace or escrow. It uses NEAR Agent Market's existing financial rails:

- `client.jobs.create()` to create a job
- `client.jobs.requestChanges()` to return unsatisfactory work
- `client.jobs.accept()` to accept the deliverable and release its escrow

The new work CALIPER adds is the **missing independent acceptance gate**: tampering detection, protected file enforcement, and independent verification that blocks payment until the buyer's original tests pass against the exact submitted artifact.

## Honesty constraint

The NEAR contract verifies a signed report from an authorized test runner, bound to the exact artifact and test suite. The runner is a trust assumption — make the test environment reproducible and let judges rerun it; do not call the result trustless proof. CALIPER proves that this exact artifact passed this exact acceptance suite in this exact environment — not that the entire software system is bug-free.

## Repo contents

- `contract/src/lib.rs` — NEAR smart contract: authority tree (`create_root`, `delegate`, `spend`, `revoke`) + job lifecycle (`create_job` with protected files, `submit_deliverable` with tampering detection, `record_independent_verification`, `accept_job`) + Promise-based settlement.
- `contract/verify/verify.ts` — independent TypeScript verifier reconstructing the authority tree and job lifecycle from exported contract state.
- 13 unit tests: proof-gated subcontracting (tampering detected, clean acceptance, independent verification failure), nested revocation accounting, commitment isolation, authority attenuation.

## Judge path (frictionless)

See `JUDGES.md`. From a clean checkout:

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown   # produces caliper.wasm
cargo test                                              # 13 passed, 0 failed
npx tsx verify/verify.ts verify/sample-valid.json       # VERIFIED (exit 0)
```

## Deadline

November 14 at 23:59 UTC. This repository is self-contained: `cargo test` and the verifier run offline and reproduce every claim in the README.
