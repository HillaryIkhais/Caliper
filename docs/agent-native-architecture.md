# Agent-Native Architecture — Applied to CALIPER

## 1. The five tests

| # | Test | CALIPER answer | Verdict |
|---|---|---|---|
| 1 | Shared action layer | The local chain (`demo/local-chain.ts`) and the contract (`contract/src/lib.rs`) implement identical state transitions. The UI/demo uses `LocalCaliperChain` as a mirror; the contract is the authority. No secret agent path. | **Yes** |
| 2 | State grounding | Jobs reference node IDs, attempt numbers, deliverable hashes, criteria hashes, baseline commits, and policy hashes. The runner pins the exact baseline commit and recomputes the policy hash before signing. | **Yes** |
| 3 | Gate placement | `release_verified_payment` is gated on verification passing; `cancel_job` is blocked for `Verified` jobs; `accept_job` revalidates coordinator authority. Irreversible write (payment transfer) is callback-confirmed. | **Yes** |
| 4 | Provenance | Attestation binds job ID, attempt, deliverable hash, criteria, baseline, suite, diff, protected-file result, test/CI exit codes, runner version, outcome. Ed25519 signature over canonical message. | **Yes** |
| 5 | Revocation | Revoking a node cascades transitively to descendants. Revocation is blocked while a verified payment obligation exists or a job awaits verification. | **Yes** |

## 2. Actors

| Actor | Role | Authority | Cannot |
|---|---|---|---|
| Owner | Creates root, funds budget | Root node, full allocation | Submit work, verify work, accept work |
| Coordinator | Posts task, pins criteria, selects bid, requests correction, approves | Root holder or delegate | Act as worker or verifier, approve unverified work |
| Worker | Submits artifact hash | Worker node, descendant of coordinator | Set acceptance criteria, report own diff, certify own tests, release payment |
| Verifier | Runs pinned suite, signs attestation | Verifier node, descendant of coordinator | Modify artifact, bid as worker, transfer funds |
| NEAR contract | Enforces authority, role separation, evidence binding, escrow settlement | Contract account | Execute arbitrary code, prove software correctness |

Role separation enforced twice: distinct authority-node IDs **and** distinct NEAR account holders.

## 3. Shared actions + schemas

| Action | authorize | execute | audit | Reversible | Requires approval |
|---|---|---|---|---|---|
| `create_root` | owner only | creates root node, attaches deposit | node created | No | No |
| `delegate` | parent holder | creates child node, attenuates permissions | node created, commitment recorded | No | No |
| `create_job` | coordinator holder | records job, escrows budget | job created | No (commitment) | No |
| `submit_deliverable` | worker holder | sets deliverable hash, increments attempt | verification cleared | No | No |
| `record_independent_verification` | verifier holder | validates attestation binding + signature | attestation recorded | No | No |
| `request_changes` | coordinator holder | reopens job after rejection | verification cleared | Yes | No |
| `accept_job` | coordinator holder | initiates settlement | payment pending | No | Yes (verification must pass) |
| `release_verified_payment` | **any account** | initiates settlement | payment pending | No | Yes (verification must pass) |
| `cancel_job` | coordinator holder | releases commitment, marks cancelled | cancellation recorded | No | No |
| `revoke` | owner or ancestor | cascades revocation, rolls up spent | revocation recorded | No | No |
| `on_job_payment` | contract (callback) | moves PaymentPending → Paid or PaymentFailed | payment confirmed | No (callback) | N/A |

## 4. Trust boundaries

- Agent (worker) cannot reach NEAR transfer directly; only the contract can transfer.
- Agent cannot self-certify; `submit_deliverable` accepts only an artifact hash.
- Agent cannot widen authority; delegation is attenuated (permissions ⊆ parent).
- Agent cannot bypass verification; `accept_job`/`release_verified_payment` require `independent_passed == true`.

## 5. Gate placement

| Action | Gate | Reason |
|---|---|---|
| `submit_deliverable` | No | Cheap, reversible (clears verification) |
| `record_independent_verification` | Yes | Verifier must be distinct holder; attestation must bind to current attempt |
| `accept_job` / `release_verified_payment` | Yes | Verification must pass; tampering must be absent |
| `cancel_job` | Yes | Blocked for `Verified` jobs (fixed payment obligation) |
| `revoke` | Yes | Blocked while obligation outstanding or job awaiting verification |
| `on_job_payment` | Contract callback | Transfer success → Paid; failure → PaymentFailed (retryable) |

## 6. Deterministic enforcement points

| Point | Mechanism | LLM role |
|---|---|---|
| Authority attenuation | `check_attenuation` at delegation | None |
| Commitment isolation | `available()` check at creation/spend | None |
| Winning-bid validation | `bid > 0 && bid <= amount` at `create_job` | None |
| Attestation binding | Hash comparison of all pinned fields | None |
| Signature verification | Ed25519 check on canonical message | None |
| Settlement amount | `winning_bid` paid verbatim | None |
| Callback confirmation | `on_job_payment` only path to `Paid` | None |
| Revocation guards | Panic if obligation outstanding | None |

The LLM (runner) proposes test execution and diff computation; the contract disposes — it cannot be fooled by a tampered attestation because every field is revalidated.

## 7. Audit / provenance schema

Attestation record:
```
actor, authority_ref, input_hash (deliverable_hash), decision (passed),
reason_code (none), output_hash (report_digest), timestamp (recorded_at),
version (ATTESTATION_VERSION), parent_action (submit_deliverable), rail_receipt (none — off-chain)
```

Job record:
```
job_id, coordinator_node, worker_node, verifier_node, budget, winning_bid,
acceptance_criteria_hash, acceptance_suite_hash, baseline_commit,
market_transcript_hash, deliverable_hash, attempt, status,
independent_passed, tampering_detected, paid_at
```

## 8. Revocation model

- Revoking a node cascades transitively to all descendants.
- Blocked if any job in the branch is `Verified`, `PaymentPending`, or `PaymentFailed` (outstanding payment obligation).
- Blocked if any job in the branch is `Submitted` and the coordinator or either role node is affected (sabotage prevention).
- `Submitted` jobs become cancellable by coordinator only after `VERIFICATION_TIMEOUT_BLOCKS = 1,000` (escape hatch for stalled verifier).
- Spent funds are rolled up into parent as spent; unspent commitments are released.

## 9. Sandbox / demo path

- **No-signup:** `npm run demo` runs with no wallet, no network, no signup.
- **Isolated:** Each demo run creates fresh state; `demo/runs/latest/` is overwritten.
- **Seeded:** Baseline fixture is pinned (commit `214225e2...`), manifest is fixed.
- **Reset:** `demo/runs/latest/` is regenerated on each run.
- **Rate limits / spend caps:** Not applicable (local simulation, no real funds).
- **No real credentials:** No wallet keys, no API keys forwarded.
- **Clear labels:** All demo output labeled "Local chain simulation"; market labeled "deterministic-commit-reveal-simulation".
- **Break path:** Eve's tampered first attempt is injected by default.

## 10. Top 3 failure modes

| Failure mode | Mechanism | Boundary |
|---|---|---|
| Revoked verifier sabotages verification | New guard blocks revocation while job is `Submitted` | Coordinator can cancel after `VERIFICATION_TIMEOUT_BLOCKS` |
| Coordinator cancels verified job to avoid payment | `cancel_job` rejects `Verified` status; `release_verified_payment` is permissionless | None — obligation is absolute once verified |
| Duplicate callback causes double payment | `on_job_payment` returns early if not `PaymentPending` | None — idempotent |

## 11. Changes required

No architecture changes required — all five tests pass. The remaining work is operational:
1. Redeploy fixed contract to testnet.
2. Execute testnet lifecycle and record hashes.
