# CALIPER — Judge's shortest path

CALIPER is the authority-control layer for autonomous agent teams: recursive, least-privilege
delegation with enforceable financial commitments and independent verification.

## What to check

| Claim | How to verify | Command |
|---|---|---|
| The contract builds | `cargo build --release --target wasm32-unknown-unknown` produces `contract/target/wasm32-unknown-unknown/release/caliper.wasm` | see below |
| Attack tests reproduce the VECT demo (4 rejections + proof) | `cargo test` → 9 passed, 0 failed | see below |
| Independent verifier accepts a valid tree | exit 0, prints `VERIFIED` | see below |
| Independent verifier rejects attenuated/commitment-violating trees | exit 1, names the violation | see below |
| The README matches what the code does | the demo sequence in README is encoded in `contract/src/lib.rs` tests | see below |

## Step-by-step (no network, no wallet, no testnet needed)

From the repo root:

```bash
cd contract

# 1. Build the contract
cargo build --release --target wasm32-unknown-unknown
ls target/wasm32-unknown-unknown/release/caliper.wasm   # ~230 KB

# 2. Run the attack tests (the VECT demo sequence)
cargo test
# expect: test result: ok. 9 passed; 0 failed

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

The 9 unit tests in `contract/src/lib.rs` encode the README's demo sequence:

- `create_root_and_delegate` — authority attenuation + commitment isolation (parent's uncommitted
  allocation drops when a child is reserved).
- `delegate_attenuation_enforced` — a child cannot get `max_per_tx` above its parent's.
- `spend_within_allocation_succeeds` — a child spends inside its own allocation.
- `spend_to_unauthorized_recipient_rejected` — deny-by-default recipient list.
- `commitment_isolation_coordinator_cannot_spend_promised_funds` — **the crucial moment**:
  the coordinator reserves 0.60 + 0.20 for its children, then tries to spend 0.80 (more than
  its 0.20 uncommitted balance) → **REJECTED**.
- `revoked_node_spend_is_rejected` — a revoked branch cannot execute.
- `revoke_child_releases_parent_commitment` — revoking a child releases budget back up.
- `revoke_root_invalidates_whole_branch_transitively` — revoking the root invalidates every
  descendant (3 revocations recorded).
- `create_root_twice_panics` — only one root.

## What the verifier proves

`verify/verify.ts` reconstructs the authority tree from exported contract state and checks all
four CALIPER guarantees:

1. **Authority attenuation** — child's permissions ⊆ parent's.
2. **Commitment isolation** — spent + children allocations ≤ allocation.
3. **Branch revocation** — revoking a node invalidates every descendant.
4. **Independent verification** — every execution ties to a valid, authorized node.

It exits 0 on a valid tree and non-zero on any violation, naming the exact rule and node.

## The contract

The `caliper.wasm` build is the deployable artifact. Public methods: `init`, `create_root`,
`delegate`, `spend`, `revoke`, plus views `get_node`, `get_root`, `get_available`, `is_valid`,
`get_execution`, `list_executions`, `list_revocations`, `get_total_locked`.

## Deadline

November 14 at 23:59 UTC. This repository is self-contained: `cargo test` and the verifier
run offline and reproduce every claim in the README.
