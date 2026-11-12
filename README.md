# CALIPER — Independent Acceptance for Agent-Created Code

**A coding agent can make its CI green by weakening the tests. CALIPER catches the manipulation.**

AI agents can hire other AI agents. But who controls the money and authority when those agents start hiring their own subcontractors — and who verifies that the hired agent actually fixed the problem, instead of just fixing the measurement of its own performance?

CALIPER is an on-chain authority and settlement system for autonomous subcontracting with **independent acceptance**. It lets agents delegate budget recursively with strictly enforced least-privilege, and — crucially — prevents acceptance and payment of work that has not passed independent verification.

## The failure CALIPER prevents

When you hire an AI coding agent to fix a bug, it cannot fix the bug — so it deletes the failing test, weakens an assertion, or disables the check in CI. Its branch turns green. The coordinator sees "all tests passed" and pays.

The agent has not fixed the software. It has **fixed the measurement of its own performance**.

This is a documented risk. OWASP's Secure Coding with AI guidance identifies test deletion, weakened assertions, and disabled checks as agent-coding risks. OpenAI has documented reward-hacking behavior in which coding agents edit tests or disable checks to make evaluations pass.

## What CALIPER enforces

| Guarantee | Meaning |
|---|---|
| **Authority attenuation** | A child cannot acquire permissions, recipients, assets or spending limits its parent does not possess. |
| **Commitment isolation** | A parent cannot spend funds already committed to its children. A child cannot spend or delegate beyond its uncommitted allocation. |
| **Branch revocation** | Revoking a parent invalidates every descendant. Unrelated branches survive. |
| **Independent acceptance** | A job cannot be accepted unless independent_passed=true AND tampering_detected=false. |

## The signature product moment

```
OWNER creates root authority: 1.0 NEAR
  ↓ delegate 0.60 NEAR, research permissions
  ↓ delegate 0.20 NEAR, verifier permissions  
  ↓ coordinator tries to spend 0.80 NEAR → REJECTED

Coordinator has only 0.20 NEAR uncommitted. The 0.60 and 0.20 are already reserved as commitments.
```

This is commitment isolation in action — financial commitments cannot be reused.

## Commitment isolation details

When a job is created, the job's budget is moved from `committed_to_children` (which tracks commitments reserved for children) to the parent's available balance. When the job is accepted, the budget moves to `spent`. This ensures proper accounting:

1. **Job creation**: Budget reserved in `committed_to_children`
2. **Job acceptance**: Budget moves from `committed_to_children` → `spent`, transferred to worker via Promise
3. **Job failure**: Budget remains in `committed_to_children` until corrective work is submitted

## The contract

The NEAR contract implements:

- `init(owner)` — Initialize with root owner
- `create_root(holder, allocation, permissions)` — Create root authority node
- `delegate(parent, holder, permissions, allocation, expiry)` — Create attenuated child
- `spend(node, recipient, amount, asset)` — Execute a spend with Promise-based settlement
- `revoke(node)` — Transitively invalidate a branch
- `create_job(coordinator, worker, verifier, budget, acceptance_hash, protected_files)` — Create subcontracting job
- `submit_deliverable(job, hash, modified_files)` — Worker submits work
- `record_independent_verification(job, report_hash, passed)` — Authenticated verifier records result
- `accept_job(job)` — Coordinator accepts with Promise-based payment

View methods: `get_node`, `get_root`, `get_owner`, `get_available`, `is_valid`, `get_execution`, `list_executions`, `list_revocations`, `get_job`, `list_jobs`, `get_total_locked`.

## Independent verifier (off-chain)

`contract/verify/verify.ts` reconstructs exported contract state and verifies:

1. **Authority attenuation** — child permissions ⊆ parent permissions
2. **Commitment isolation** — spent + sum(children allocations) ≤ allocation  
3. **Branch revocation** — revoked nodes and descendants are inactive
4. **Node ordering** — `created_at` timestamps enforce proper causality

```bash
# Run the verifier
npx tsx verify/verify.ts verify/sample-valid.json       # VERIFIED (exit 0)
npx tsx verify/verify.ts verify/sample-invalid-attenuation.json  # FAILED (exit 1)
npx tsx verify/verify.ts verify/sample-invalid-commitment.json   # FAILED (exit 1)
```

## Repo contents

- `contract/src/lib.rs` — NEAR WASM contract (~286 KB)
- `contract/verify/verify.ts` — TypeScript verifier
- 13 unit tests proving all guarantees
- Valid and invalid fixtures for verification

## Judge path (offline, no network required)

From a clean checkout:

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown   # produces caliper.wasm
cargo test                                              # 13 passed, 0 failed
npx tsx verify/verify.ts verify/sample-valid.json       # VERIFIED (exit 0)
```

## Deadline

November 14 at 23:59 UTC. This repository is self-contained and reproducible from source.