# Verification Loop — Applied to CALIPER

## 1. Property to verify

**"A job is paid exactly the winning bid, and only after independent verification passes against the current artifact, attempt, acceptance criteria, baseline, acceptance suite, and verifier key."**

Sub-properties:
- `spent == winning_bid` after settlement (not `budget`).
- `winning_bid > 0 && winning_bid <= budget` at job creation.
- `Verified` jobs cannot be cancelled.
- `release_verified_payment` is permissionless after verification.
- Revocation is blocked while a payment obligation is outstanding.
- `on_job_payment` is idempotent (duplicate callbacks cannot double-pay).

## 2. Artifact schema

**Attestation** (the artifact being verified):
```
type VerificationAttestation = {
  version: string;              // caliper-attestation-v2
  job_id: JobId;
  attempt: u32;
  deliverable_hash: string;
  acceptance_criteria_hash: string;
  baseline_commit: string;
  acceptance_suite_hash: string;
  diff_hash: string;
  deliverable_matches_claim: bool;
  protected_files_clean: bool;
  test_exit_code: i32;
  ci_exit_code: i32;
  runner_version: string;
  passed: bool;
  report_digest: string;
  verifier_public_key: string;
  signature: string;
}
```

**Job state** (the artifact being settled):
```
type Job = {
  id, coordinator_node, worker_node, verifier_node,
  budget, winning_bid,
  acceptance_criteria_hash, acceptance_suite_hash, baseline_commit,
  market_transcript_hash, deliverable_hash, attempt, status,
  independent_passed, tampering_detected, paid_at
}
```

## 3. Failure fixtures

| Fixture | Description | Expected oracle result |
|---|---|---|
| `sha256:artifact` (tampered) | Worker modifies `ci/check.js` and `tests/auth.test.js` | `invalid` — protected_files_clean=false |
| `sha256:tampered-criteria` | Attestation uses different acceptance criteria | `invalid` — stale attestation |
| `sha256:different-artifact` | Attestation for different deliverable hash | `invalid` — stale deliverable |
| Wrong verifier signature | Signature over canonical message with wrong key | `invalid` — signature mismatch |
| Old attempt attestation | Attestation for attempt 1, current attempt is 2 | `invalid` — stale attempt |
| Bid > budget | `winning_bid > budget` at creation | `invalid` — creation rejected |
| Duplicate callback | `on_job_payment` called twice after success | Idempotent — second call is no-op |

## 4. Oracle + bound

**Oracle:** The NEAR contract itself, plus the TypeScript local-chain mirror.

| Property | Oracle type | Bound |
|---|---|---|
| `winning_bid <= budget` | Constraint check at `create_job` | Constant time |
| Attestation binding | Hash field comparison | Constant time per field |
| Signature validity | Ed25519 verify | Constant time |
| `spent == winning_bid` after settlement | State inspection | Constant time |
| Revocation guard | Iterate all jobs | O(jobs) per revocation |
| Duplicate callback idempotency | Early return if not `PaymentPending` | Constant time |

**Bound statement:** All oracles are constant-time or O(n) over stored state. No probabilistic search. Result is `valid / invalid`, never `unknown`.

**Soundness + bounded completeness:** Every "valid" result is backed by a verifiable signature and rechecked binding. Every "invalid" result has a specific reason code.

## 5. Repair constraints

| Constraint | Requirement |
|---|---|
| Max edits per repair | N/A — contract logic is deterministic, no patching at runtime |
| Must preserve | Winning-bid settlement, permissionless release, revocation guards |
| Must not | Delete the verification requirement, allow self-certification, allow double payment |
| Must keep | Schema validity, all other invariants |

## 6. Fresh-run verification

**Contract tests (41 tests):** Each test creates a fresh `Contract::new_for_test()` instance, runs a scenario, and asserts the final state. No test shares state with another.

**Key fresh-run tests:**
- `settlement_pays_winning_bid_and_returns_unused_budget` — fresh job, settlement, asserts `spent == winning_bid` and `committed_to_children` returns full budget.
- `worker_revocation_does_not_block_permissionless_settlement` — fresh job, verify, revoke worker, third party releases payment, asserts `Paid`.
- `coordinator_with_verified_payment_cannot_be_revoked` — fresh job, verify, attempts revocation, asserts panic.
- `verified_job_cannot_be_cancelled` — fresh job, verify, attempts cancellation, asserts panic.
- `revoked_verifier_cannot_attest` — fresh job, submit, revoke verifier, asserts revocation blocked.

**Off-chain tests (21 tests):** Each test runs `runSwarm()` or `verifyArtifact()` with fresh state. The e2e test asserts the full adversarial loop: attempt 1 rejected, attempt 2 verified, settlement paid exactly winning bid.

## 7. Evidence artifacts

| Artifact | Location | Content |
|---|---|---|
| Contract test results | `contract/src/lib.rs` | 41 tests, all pass |
| Off-chain test results | `demo/*.test.ts` | 21 tests, all pass |
| Verify fixtures | `contract/verify/sample-*.json` | Both pass `npm run verify` |
| Wasm build | `contract/target/wasm32-unknown-unknown/release/caliper.wasm` | Release build succeeds |
| Testnet views | `near/evidence/testnet-lifecycle.md` | `get_root=null`, `get_total_allocated="0"`, `list_jobs=[]` |

## 8. Metrics + known limits

| Metric | Value |
|---|---|
| Contract tests | 41/41 pass |
| Off-chain tests | 21/21 pass |
| Verify fixtures | 2/2 pass |
| Wasm build | Success |
| Testnet lifecycle | Not executed (deployed bytecode predates fixes) |
| False positives | 0 (tests assert exact expected panics and states) |
| False negatives | N/A — deterministic checks, no search |

**Known limits:**
- The deployed testnet bytecode predates the fixes; redeploy required.
- The testnet lifecycle has not been executed; `near/scripts/testnet-lifecycle.sh` is provided but unrun.
- Runner isolation: default is process-only (not a security boundary); `CALIPER_SANDBOX=os` opts into fail-closed sandbox.

## 9. Demo scene

**Break:** Submit a deliverable that modifies `ci/check.js` (disables CI) and `tests/auth.test.js` (weakens assertions).

**Detect:** Runner restores pinned suite, runs original tests, gets non-zero exit codes, marks `protected_files_clean=false`, `passed=false`.

**Repair:** Worker fixes `src/auth.js` only; protected files unchanged.

**Verify:** Fresh run of pinned suite against corrected source; `test_exit_code=0`, `ci_exit_code=0`, `passed=true`.

**Prove:** Ed25519-signed attestation recorded; `release_verified_payment` by worker; contract pays exactly `winning_bid`; callback confirms `Paid`.
