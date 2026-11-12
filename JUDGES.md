# CALIPER — Judge's shortest path

CALIPER is proof-gated subcontracting for autonomous agent teams: an on-chain authority and settlement system that lets AI agents hire other agents, delegate work recursively, and — crucially — prevents an agent from accepting and paying for work that has not passed independent verification.

## What to check

| Claim | How to verify | Command |
|---|---|---|
| The contract builds | `cargo build --release --target wasm32-unknown-unknown` produces `contract/target/wasm32-unknown-unknown/release/caliper.wasm` | see below |
| Attack/repair tests reproduce the proof-gated demo | `cargo test` → 11 passed, 0 failed | see below |
| Independent verifier accepts a valid tree | exit 0, prints `VERIFIED` | see below |
| Independent verifier rejects attenuated/commitment-violating trees | exit 1, names the violation | see below |
| The README matches what the code does | the demo sequence in README is encoded in `contract/src/lib.rs` tests | see below |

## Step-by-step (no network, no wallet, no testnet needed)

From the repo root:

```bash
cd contract

# 1. Build the contract
cargo build --release --target wasm32-unknown-unknown
ls target/wasm32-unknown-unknown/release/caliper.wasm   # ~274 KB

# 2. Run the tests (the proof-gated subcontracting demo sequence)
cargo test
# expect: test result: ok. 11 passed; 0 failed

# 3. Run the independent verifier
npx tsx verify/verify.ts verify/sample-valid.json
# expect: VERIFIED ... (exit 0)
echo $?   # 0

npx tsx verify/verify.ts verify/sample-invalid-attenuation.json
# expect: FAILED ... [attenuation] ... (exit 1)
echo $?   # 1

npx tsx verify/verify.ts verify/sample-invalid-commitment.json
# expect: FAILED ... [commitment] ... (exit 1)
echo $?   # 1
```

## What the tests prove

The 11 unit tests in `contract/src/lib.rs` encode the README's demo sequence:

- `create_root_and_delegate` — authority attenuation + commitment isolation.
- `delegate_attenuation_enforced` — a child cannot get `max_per_tx` above its parent's.
- `spend_within_allocation_succeeds` — a worker spends inside its own allocation.
- `spend_to_unauthorized_recipient_rejected` — deny-by-default recipient list.
- `commitment_isolation_coordinator_cannot_spend_promised_funds` — **the crucial moment**: the coordinator reserves funds for its children, then tries to spend more than its uncommitted balance → **REJECTED**.
- `revoked_node_spend_is_rejected` — a revoked branch cannot execute.
- `revoke_child_releases_parent_commitment` — revoking a child releases budget back up.
- `revoke_root_invalidates_whole_branch_transitively` — revoking the root invalidates every descendant.
- `nested_revocation_releases_correct_commitments` — revoking an interior node releases only that node's allocation from its direct parent; ancestors' commitments are unchanged.
- `proof_gated_subcontracting_broken_then_fixed` — **the VECT-style demo**: create job → worker submits broken deliverable → verification fails (Rejected) → worker submits revised deliverable → verification passes (Accepted) → coordinator accepts → payment released (spent counter increments).
- `create_root_twice_panics` — only one root.

## What the verifier proves

`verify/verify.ts` reconstructs the authority tree and job lifecycle from exported contract state and checks all four CALIPER guarantees:

1. **Authority attenuation** — child's permissions ⊆ parent's.
2. **Commitment isolation** — spent + children allocations ≤ allocation.
3. **Branch revocation** — revoking a node invalidates every descendant; execution chronology checked against revocation block heights.
4. **Independent verification** — every execution, submission, verification and acceptance ties to a valid, authorized node at the time it occurred.

It exits 0 on a valid tree and non-zero on any violation, naming the exact rule and node.

## The contract

The `caliper.wasm` build is the deployable artifact. Public methods: `init`, `create_root`, `delegate`, `spend`, `revoke`, `create_job`, `submit_deliverable`, `record_verification`, `accept_job`, plus views `get_node`, `get_root`, `get_available`, `is_valid`, `get_execution`, `list_executions`, `list_revocations`, `get_job`, `list_jobs`, `get_total_locked`.

## Deadline

November 14 at 23:59 UTC. This repository is self-contained: `cargo test` and the verifier run offline and reproduce every claim in the README.
