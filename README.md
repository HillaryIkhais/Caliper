# CALIPER — Proof-Gated Subcontracting for Autonomous Agent Teams

**AI agents can hire other AI agents. But who controls the money and authority when those agents start hiring their own subcontractors?**

CALIPER is an on-chain authority and settlement system for autonomous subcontracting. It lets agents hire other agents, delegate work and budget recursively, and — crucially — prevents an agent from accepting and paying for work that has not passed independent verification.

## The problem

Existing wallet firewalls (Veto, Banbo, NEAR Agent API) govern what a single agent can spend. None of them govern the chain of authority and financial commitment that forms when a coordinator hires workers, who hire their own subcontractors.

The dangerous failure isn't simply an agent overspending:

- A child receives permissions broader than its task.
- A coordinator spends funds already promised to subcontractors.
- A compromised child delegates authority to an attacker.
- A revoked agent's descendants continue acting.
- **A worker submits broken work, claims success, and gets paid anyway.**

That last one is CALIPER's core: **no payment without verified acceptance.**

## The product loop (proof-gated subcontracting)

KEEP THE FIRST VERSION NARROW: software bug fixes, because they have tests that objectively pass or fail.

1. **Owner submits a task.** Example: "Fix this bug in a NEAR contract." Supplies the repository, base commit, budget, and acceptance tests.
2. **Coordinator hires a worker.** CALIPER creates the job with a fixed budget and an immutable acceptance-suite hash. The worker cannot replace the acceptance suite with their own tests.
3. **Worker submits a deliverable.** CALIPER captures the exact artifact hash. "Fixed" is not enough.
4. **Independent runner tests it.** A separate, isolated runner executes the pinned tests against that exact revision.
5. **Failure triggers repair.** CALIPER records the failure evidence and permits one bounded revision.
6. **Pass triggers acceptance.** CALIPER records the verification receipt on NEAR and accepts the deliverable. Payment follows verified acceptance.
7. **Unresolved failure gets a human gate.** No LLM casually declares ambiguous work successful.

## The demo that makes judges understand it

**One task. Two submissions. One verified payment.**

1. Worker submits a broken patch → commit exists, regression test fails → **ACCEPTANCE REJECTED**
2. CALIPER returns failure evidence → identifies the failed test → asks for one correction
3. Worker submits a revised patch → CALIPER runs the same pinned suite → **ALL TESTS PASS**
4. CALIPER records the receipt and accepts → marketplace releases payment → judge inspects artifact hash, suite hash, test result, payment record → **VERIFIED ACCEPTANCE**

That is the VECT-style story: submit → break → detect → repair → verify → accept → prove.

## What CALIPER enforces (four guarantees)

1. **Authority attenuation** — a child cannot acquire permissions, recipients, assets or spending limits its parent does not possess.
2. **Commitment isolation** — a parent cannot spend funds already committed to its children. A child cannot spend or delegate beyond its own uncommitted allocation.
3. **Branch revocation** — revoking a parent invalidates every descendant, including pending authority and subsequent execution attempts. Unrelated branches survive.
4. **Independent verification** — an external verifier reconstructs the authority tree and job lifecycle from contract state and checks every allocation, execution, submission, verification and acceptance against the invariants.

## The authority tree (enabling mechanism)

Recursive delegation exists to protect the subcontracting workflow:

```
OWNER
# 1.00 NEAR  — root authority and treasury allocation

COORDINATOR
# 0.60 Research · 0.20 Verification · 0.20 available

RESEARCH
# 0.60  — research payments only

SUB-SPECIALIST
# smaller budget and permissions — hired by Research
```

Each worker receives task-specific authority, a reserved budget, an expiry, and explicit delegation rules. Every descendant is checked against the full chain of authority that created it.

## The receipt

Every accepted job produces a verifiable receipt binding: job ID, worker, base revision, submitted artifact hash, acceptance-suite hash, runner version, test result, and verifier identity. A previous passing receipt cannot be reused for a different artifact.

## Honesty constraint

The NEAR contract verifies a signed report from an authorized test runner, bound to the exact artifact and test suite. The runner is a trust assumption — make the test environment reproducible and let judges rerun it; do not call the result trustless proof.

## Competitive position

| Project | Core question |
|---|---|
| Veto | Can this wallet execute this transaction under its spending policy? |
| Banbo | Did the payment instructions come from a trusted source? |
| Digi Swarm Treasury | Can agents coordinate and split revenue on testnet? |
| CALIPER | Can an agent hire subcontractors and only pay for work that passes independent verification? |

CALIPER doesn't compete with Veto at payment screening or Banbo at provenance verification. Its claim is deeper: **authority and money can flow through an autonomous subcontracting hierarchy without privilege escalation, double commitment, or payment for unverified work.**

## Repo contents

- `contract/src/lib.rs` — NEAR smart contract: authority tree (`create_root`, `delegate`, `spend`, `revoke`) + job lifecycle (`create_job`, `submit_deliverable`, `record_verification`, `accept_job`) + Promise-based settlement.
- `contract/verify/verify.ts` — independent TypeScript verifier reconstructing the authority tree and job lifecycle from exported contract state.
- 11 unit tests: proof-gated subcontracting (broken → rejected → revised → accepted → paid), nested revocation accounting, commitment isolation, authority attenuation.

## Judge path (frictionless)

See `JUDGES.md`. From a clean checkout:

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown   # produces caliper.wasm
cargo test                                              # 11 passed, 0 failed
npx tsx verify/verify.ts verify/sample-valid.json       # VERIFIED (exit 0)
```

## Deadline

November 14 at 23:59 UTC. This repository is self-contained: `cargo test` and the verifier run offline and reproduce every claim in the README.
