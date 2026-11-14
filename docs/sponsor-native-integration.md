# Sponsor-Native Integration — Applied to CALIPER

## 1. Sponsor + primitive

| Field | Value |
|---|---|
| Sponsor | NEAR |
| Primitive/rail | NEAR testnet account `caliper.testnet`, native NEAR transfers, function-call access keys, WASM contract deployment |
| What it uniquely enables | Protocol-level enforcement of authority, escrow, signature verification, and callback-confirmed settlement |
| What the sponsor lacks a reference for | A verified labor market where independent attestation gates NEAR payment |
| Our workflow | Owner → root → delegate → create_job (escrow + winning_bid) → submit_deliverable → record_independent_verification → release_verified_payment → on_job_payment → Paid |
| Where the primitive is load-bearing | The NEAR contract is the single source of truth for escrow, settlement, and authority. Without it, there is no enforceable payment obligation. |
| What breaks if removed | The entire product — there is no escrow, no callback-confirmed payment, no authority enforcement, no revocation |
| Evidence judge can inspect | `caliper.testnet` deployed code hash, tx hash, view method results (`get_root=null`, `list_jobs=[]`) |
| Limits | Testnet funds non-redeemable; deployed bytecode predates fixes; lifecycle unexecuted |
| Fallback behavior | Local simulation (`demo/local-chain.ts`) mirrors contract semantics exactly |
| What the primitive must never decide | The winner of the bid market (off-chain simulation), software correctness (contract does not execute code) |

## 2. Workload and where it is load-bearing

The NEAR integration is **L3 — load-bearing**:

- **L1 (Badge):** API called once, logo on slide. ❌ Not CALIPER.
- **L2 (Panel):** Data in, display out. ❌ Not CALIPER.
- **L3 (Load-bearing):** Core loop depends on it; inspectable in the workflow. ✅ CALIPER.

The contract enforces:
- Authority attenuation at delegation
- Commitment isolation at job creation and spend
- Winning-bid settlement at payment
- Callback confirmation at `Paid`
- Revocation guards at `revoke`

Without NEAR, none of these are enforceable.

## 3. Remove-the-API test

Remove NEAR → the product loses all core value:
- No escrow: coordinator cannot commit budget.
- No signature verification: verifier attestation has no on-chain anchor.
- No callback confirmation: no way to distinguish `PaymentPending` from `Paid`.
- No authority tree: no role separation, no revocation cascade.

The API is not decorative — it is the enforcement layer.

## 4. Inspectability surface

Inside the product, a judge can see:

| Item | Source | Location |
|---|---|---|
| Deployed code hash | RPC `view_code` | `near/evidence/testnet-lifecycle.md` |
| Account balance | RPC `view_account` | `near/evidence/testnet-lifecycle.md` |
| Transaction status | RPC `tx` | `near/evidence/testnet-lifecycle.md` |
| Owner | `get_owner()` view | README, JUDGES.md |
| Root | `get_root()` view | README, JUDGES.md |
| Total allocated | `get_total_allocated()` view | README, JUDGES.md |
| Jobs | `list_jobs()` view | README, JUDGES.md |
| Test source code | Git repo | `contract/src/lib.rs` |
| Test results | `cargo test` output | docs/verification-loop.md |
| Attestation canonical body | `shared/attestation.ts` + `contract/src/lib.rs` | README |

## 5. Evidence + timestamps + limits

| Evidence | Timestamp | Limit |
|---|---|---|
| Deployment tx `HkwyEMPr...` | FINAL at block `CV8aCm1...` | Testnet only |
| Code hash `Hst7gb5b...` | Block 277626735 | Predates fixes |
| Balance 9,997.3 NEAR | Block 277626729 | Non-redeemable testnet |
| `get_root` → `null` | Current finality | Lifecycle unexecuted |
| `list_jobs` → `[]` | Current finality | No jobs created |

## 6. Authority boundary (what NEAR never decides)

The NEAR contract must **never** decide:

| Decision | Who decides | Why |
|---|---|---|
| Bid market winner | Off-chain deterministic simulation | Contract does not validate auctions |
| Software correctness | Independent verifier (off-chain) | Contract cannot execute code |
| Acceptance criteria | Coordinator (pinned at creation) | Contract stores hash only |
| Test/CI commands | Manifest (pinned at creation) | Contract stores hash only |
| Worker selection | Coordinator (records market selection) | Contract records, does not choose |

Research informs (off-chain verifier determines if fix is correct); settlement decides (NEAR transfers exactly `winning_bid` on callback confirmation).

## 7. Fallback behavior

| Scenario | Fallback |
|---|---|
| NEAR testnet unavailable | Local simulation (`npm run demo`) — identical state machine, labeled as simulation |
| Contract not deployed | Same local simulation; judge can inspect source and tests |
| Verifier unavailable | Job stays `Submitted`; coordinator can cancel after `VERIFICATION_TIMEOUT_BLOCKS` |
| Transfer fails | `PaymentFailed`; budget remains reserved; retry is idempotent |

## 8. Track fit / judge legibility

| Criterion | Rating | Rationale |
|---|---|---|
| Judge depth | 5 | NEAR function-call keys and authority are native to the contract |
| Competition | 4 | Few teams build verifiable labor markets with callback-confirmed settlement |
| Sponsor need | 5 | NEAR lacks a reference integration for verified agent labor + escrow |
| Primitive centrality | 5 | NEAR is the brain, not a badge |
| Proof affinity | 5 | View methods are mechanically checkable without signup |
| Demo friction | 5 | `npm run demo` — no wallet, no network, no signup |
| Time fit | 5 | Single loop closes in the demo |

**Total: 34/35 — excellent track fit.**

## 9. Demo scene

1. Judge runs `npm run demo` — sees Eve's tampered attempt rejected, correction verified, payment settled.
2. Judge runs `near view caliper.testnet get_total_allocated` → `"0"` — sees lifecycle is unexecuted (honest limitation).
3. Judge runs `cargo test` — 41 tests pass, including exact-bid settlement and revocation guards.
4. Judge inspects `contract/src/lib.rs` — sees `winning_bid` field, `release_verified_payment`, cancellation guard, revocation guard.

## 10. Non-claims

| Non-claim | Reason |
|---|---|
| On-chain auction | Market is off-chain simulation; contract records selection only |
| On-chain winner selection | Contract does not validate bids or select winners |
| Testnet lifecycle executed | `get_root=null`, `list_jobs=[]` — not yet run |
| Updated contract deployed | Deployed bytecode predates fixes; redeploy required |
| OS-level sandbox (default) | Default is process-only; `CALIPER_SANDBOX=os` is opt-in fail-closed |
